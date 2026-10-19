import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { REACTION_EMOJIS, type TaskEvent } from "@quokkabot/shared";
import { App } from "../src/app.js";
import { chatItems } from "../src/chat.js";
import { api } from "../src/api.js";
import { agent, agentId, at, detail, domainRequest, domainRequestId, emptyDomains, hash, json, me, ownerRequest, run, task, taskId } from "./fixtures.js";

vi.mock("@simplewebauthn/browser", () => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }));

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = MockEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { MockEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(seq: number, event: TaskEvent) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ taskId, seq, at, event }), lastEventId: String(seq) }));
  }
}

type Handler = (path: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
let handler: Handler;
let clients: QueryClient[];
const fetchMock = vi.fn<typeof fetch>();

function renderApp(path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><RouteLocation /></MemoryRouter></QueryClientProvider>);
}

function RouteLocation() {
  const location = useLocation();
  return <output aria-label="App route">{location.pathname}{location.search}</output>;
}

async function openChat(path = `/agents/${agentId}`) {
  renderApp(path);
  await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
  const source = MockEventSource.instances[0];
  if (!source) throw new Error("Task EventSource was not opened");
  return source;
}

function requestBody(path: string, method = "POST") {
  const call = fetchMock.mock.calls.find(([url, init]) => url === path && init?.method === method);
  if (!call) throw new Error(`No ${method} ${path} request`);
  expect(call[1]?.credentials).toBe("same-origin");
  return call[1]?.body === undefined ? undefined : JSON.parse(String(call[1].body)) as unknown;
}

beforeEach(() => {
  clients = [];
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  handler = () => undefined;
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    const custom = await handler(path, init);
    if (custom) return custom;
    if (path === "/api/me") return json(me);
    if (path === "/api/agents") return json({ agents: [agent], capacity: { used: 1, total: 2 } });
    if (path === "/api/inbox") return json({ items: [] });
    if (path === `/api/agents/${agentId}`) return json(agent);
    if (path === `/api/tasks/${taskId}`) return json(detail);
    if (path.startsWith(`/api/agents/${agentId}/tasks?`)) return json({ tasks: [task], nextBefore: null });
    if (path === `/api/agents/${agentId}/logins`) return json({ logins: [] });
    if (path === "/api/sessions") return json({ sessions: [] });
    if (path === `/api/agents/${agentId}/domains`) return json(emptyDomains);
    if (path.startsWith(`/api/agents/${agentId}/files?`)) {
      const url = new URL(path, "https://quokkabot.test");
      return json({ scope: url.searchParams.get("scope"), dir: url.searchParams.get("dir"), entries: [], nextCursor: null });
    }
    if (path.startsWith(`/api/agents/${agentId}/audit?`)) return json({ events: [], head: { seq: 0, hash } });
    throw new Error(`Unexpected fetch ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { clients.forEach(client => client.clear()); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("task stream", () => {
  it("renders deltas, replaces the draft with final text and resumes with the last validated seq", async () => {
    const source = await openChat();
    expect(source.url).toBe(`/api/tasks/${taskId}/events?after=0`);
    act(() => {
      source.onopen?.(new Event("open"));
      source.emit(1, { kind: "assistant_delta", text: "Draft " });
      source.emit(2, { kind: "assistant_delta", text: "https://untrusted.example <b>text</b>" });
      source.emit(3, { kind: "tool_call", tool: "browser_download", summary: "Save invoice" });
    });
    expect(screen.getByText("Draft https://untrusted.example <b>text</b>")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /untrusted/ })).toBeNull();
    act(() => source.emit(4, { kind: "assistant_text", text: "The invoice is saved." }));
    expect(screen.getByText("The invoice is saved.")).toBeTruthy();
    expect(screen.queryByText(/Draft https/)).toBeNull();
    act(() => source.onerror?.(new Event("error")));
    // Native reconnect keeps the object and its Last-Event-ID, rather than opening from sequence zero.
    expect(source.closed).toBe(false);
    expect(MockEventSource.instances).toHaveLength(1);
    act(() => { source.onopen?.(new Event("open")); source.emit(4, { kind: "assistant_text", text: "Duplicate final" }); source.emit(5, { kind: "assistant_delta", text: "Next update" }); });
    expect(screen.queryByText("Duplicate final")).toBeNull();
    expect(screen.getByText("Next update")).toBeTruthy();
    // A reconnect the server answered with 502 closes the EventSource: a new one resumes after a short wait, quietly.
    act(() => { source.readyState = MockEventSource.CLOSED; source.onerror?.(new Event("error")); });
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
    expect(source.closed).toBe(true);
    const resumed = MockEventSource.instances[1];
    if (!resumed) throw new Error("Automatic reconnect did not open EventSource");
    expect(resumed.url).toBe(`/api/tasks/${taskId}/events?after=5`);
    act(() => resumed.emit(6, { kind: "assistant_text", text: "Next final" }));
    expect(screen.getByText("Next final")).toBeTruthy();
    expect(screen.queryByText("Next update")).toBeNull();
  });

  it("keeps retrying through a server restart and clears the notice once the stream is back", async () => {
    const source = await openChat();
    handler = path => path === "/api/me" ? new Response("Bad Gateway", { status: 502 }) : undefined;
    act(() => { source.readyState = MockEventSource.CLOSED; source.onerror?.(new Event("error")); });
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
    const second = MockEventSource.instances[1];
    if (!second) throw new Error("First automatic reconnect did not open EventSource");
    act(() => { second.readyState = MockEventSource.CLOSED; second.onerror?.(new Event("error")); });
    expect(screen.getByRole("alert").textContent).toBe("Reconnecting to Quokka Bot…");
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(3), { timeout: 2000 });
    expect(screen.queryByText(/HTTP 502/)).toBeNull();
    const third = MockEventSource.instances[2];
    if (!third) throw new Error("Second automatic reconnect did not open EventSource");
    act(() => third.onopen?.(new Event("open")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  it("shows malformed events as an error and leaves their sequence unacknowledged", async () => {
    const source = await openChat();
    act(() => source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ taskId, seq: 1, at, event: { kind: "assistant_delta", text: 12 } }), lastEventId: "1" })));
    expect(screen.getByRole("alert").textContent).toContain("Task event: invalid response");
    expect(source.closed).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(MockEventSource.instances[1]?.url).toContain("after=0");
  });

  it("refreshes the task on a supervisor run event and shows event errors", async () => {
    const source = await openChat();
    fetchMock.mockClear();
    act(() => {
      source.emit(1, { kind: "run", run: { ...run, state: "lost" } });
      source.emit(2, { kind: "error", message: "The supervisor lost the process" });
    });
    expect(screen.getByText("The supervisor lost the process")).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === `/api/tasks/${taskId}`)).toBe(true));
  });
});

it("posts a question reply through the composer and clears the answer", async () => {
  let answered = false;
  handler = path => {
    if (path === `/api/tasks/${taskId}`) return json({ ...detail, openRequests: answered ? [] : [ownerRequest] });
    if (path === `/api/tasks/${taskId}/reply`) { answered = true; return json(task); }
    return undefined;
  };
  const source = await openChat();
  act(() => source.emit(1, { kind: "owner_request", request: ownerRequest }));
  expect(screen.getByText(ownerRequest.text)).toBeTruthy();
  const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  expect(composer.disabled).toBe(false);
  expect(composer.placeholder).toBe(`Answer ${agent.name}`);
  fireEvent.change(composer, { target: { value: "October 2026" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(composer.value).toBe(""));
  expect(requestBody(`/api/tasks/${taskId}/reply`)).toEqual({ text: "October 2026", attachmentIds: [] });
  expect(screen.getByText(ownerRequest.text)).toBeTruthy();
  expect(composer.disabled).toBe(true);
});

it.each([
  ["Allow for this task", "allow_task", false],
  ["Allow for this task", "allow_task", true],
  ["Always allow", "allow_always", false],
  ["Always allow", "allow_always", true],
  ["Refuse", "refuse", true],
  ["Refuse", "refuse", false],
] as const)("posts %s with the right decision and attended flag", async (button, decision, attended) => {
  handler = path => {
    if (path === "/api/inbox") return json({ items: [{ kind: "domain_request", agentId, taskTitle: task.title, request: domainRequest }] });
    if (path === `/api/domain-requests/${domainRequestId}/decide`) return json(emptyDomains);
    return undefined;
  };
  await openChat();
  await screen.findByText(`Allow ${domainRequest.domains.join(", ")}`);
  if (attended) fireEvent.click(screen.getByRole("checkbox", { name: "Only while I watch" }));
  fireEvent.click(screen.getByRole("button", { name: button }));
  await waitFor(() => expect(screen.queryByText(domainRequest.reason)).toBeNull());
  expect(requestBody(`/api/domain-requests/${domainRequestId}/decide`)).toEqual({ decision, attended });
});

it("shows a request for sites where the agent asked and closes it when the owner writes instead", async () => {
  const requestId = domainRequest.id;
  let open = true;
  handler = (path, init) => {
    if (path === "/api/inbox") return json({ items: open ? [{ kind: "domain_request", agentId, taskTitle: task.title, request: { ...domainRequest, domains: ["*.roblox.com", "*.rbxcdn.com"] } }] : [] });
    if (path === `/api/tasks/${taskId}`) return json({ ...detail, task: { ...task, blockedReason: "domain_request" } });
    if (path === `/api/tasks/${taskId}/reply` && init?.method === "POST") { open = false; return json(task); }
    return undefined;
  };
  const source = await openChat();
  act(() => {
    source.onopen?.(new Event("open"));
    source.emit(1, { kind: "owner_message", text: "Read the Roblox stats.", attachments: [] });
    source.emit(2, { kind: "domain_request", requestId, domains: ["*.roblox.com", "*.rbxcdn.com"], reason: "Sign in to Roblox" });
    source.emit(3, { kind: "assistant_text", text: "Waiting for Roblox access." });
  });
  const card = (await screen.findByText("Allow roblox.com and rbxcdn.com")).closest("article");
  if (!card) throw new Error("No site request card");
  // The card stays where it was asked: the agent's later message comes after it.
  expect(card.compareDocumentPosition(screen.getByText("Waiting for Roblox access.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const box = await screen.findByPlaceholderText("Reply to Office");
  fireEvent.change(box, { target: { value: "Skip Roblox, check Gmail instead." } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(requestBody(`/api/tasks/${taskId}/reply`)).toEqual({ text: "Skip Roblox, check Gmail instead.", attachmentIds: [] }));
  act(() => {
    source.emit(4, { kind: "domain_decided", requestId, decision: "skip", attended: false });
    source.emit(5, { kind: "owner_message", text: "Skip Roblox, check Gmail instead.", attachments: [] });
  });
  expect(await screen.findByText("Skipped access to roblox.com and rbxcdn.com")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow for this task" })).toBeNull();
});

it("asks for sites by name, not for every host", async () => {
  const sites = { ...domainRequest, domains: ["*.roblox.com", "*.rbxcdn.com", "*.arkoselabs.com"] };
  handler = path => path === "/api/inbox" ? json({ items: [{ kind: "domain_request", agentId, taskTitle: task.title, request: sites }] }) : undefined;
  await openChat();
  expect(await screen.findByText("Allow roblox.com, rbxcdn.com and arkoselabs.com")).toBeTruthy();
  expect(screen.queryByText(/\*\./)).toBeNull();
});

it("posts the kill switch immediately without a confirmation or passkey", async () => {
  const confirm = vi.spyOn(window, "confirm");
  let killed = false;
  handler = path => {
    if (path === `/api/agents/${agentId}/kill`) { killed = true; return json({ ...agent.computer, state: "killed", killedAt: at }); }
    if (path === `/api/agents/${agentId}` && killed) return json({ ...agent, computer: { ...agent.computer, state: "killed", killedAt: at } });
    return undefined;
  };
  renderApp(`/agents/${agentId}/computer`);
  fireEvent.click(await screen.findByRole("button", { name: "Stop everything" }));
  await waitFor(() => expect(requestBody(`/api/agents/${agentId}/kill`)).toEqual({}));
  expect(confirm).not.toHaveBeenCalled();
  expect(startAuthentication).not.toHaveBeenCalled();
  expect(await screen.findByRole("button", { name: "Release kill switch" })).toBeTruthy();
});

it("shows the server error beside the action", async () => {
  handler = path => path === `/api/agents/${agentId}/kill` ? json({ error: { code: "unreachable", message: "Supervisor socket is unavailable" } }, 503) : undefined;
  renderApp(`/agents/${agentId}/computer`);
  fireEvent.click(await screen.findByRole("button", { name: "Stop everything" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Supervisor socket is unavailable");
});

it("shows schema errors instead of rendering an invalid API response", async () => {
  handler = path => path === "/api/agents" ? json({ agents: [{ ...agent, name: 42 }] }) : undefined;
  renderApp();
  expect((await screen.findByRole("alert")).textContent).toContain("GET /agents: invalid response at agents.0.name");
  expect(screen.queryByRole("heading", { name: "Office" })).toBeNull();
});

it("routes a 401 to sign-in and clears the owner screen", async () => {
  handler = path => path === "/api/agents" ? json({ error: { code: "signed_out", message: "Session expired" } }, 401) : undefined;
  renderApp();
  expect(await screen.findByRole("button", { name: "Sign in with passkey" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Agents" })).toBeNull();
});

it("obtains a new one-time view ticket on every computer mount", async () => {
  let tickets = 0;
  handler = path => {
    if (path === `/api/agents/${agentId}`) return json({ ...agent, computer: { ...agent.computer, state: "running" } });
    if (path === `/api/agents/${agentId}/view-ticket`) { tickets++; return json({ url: `https://view.quokkabot.test/enter?ticket=${tickets}` }); }
    return undefined;
  };
  renderApp(`/agents/${agentId}/computer`);
  const iframe = await screen.findByTitle("Agent computer live view");
  expect(iframe.getAttribute("src")).toContain("ticket=1");
  fireEvent.click(screen.getByRole("link", { name: "‹ Chat" }));
  await screen.findByRole("button", { name: "Stop" });
  expect(screen.queryByTitle("Agent computer live view")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Computer" }));
  fireEvent.click(screen.getByRole("link", { name: "Open computer" }));
  await waitFor(() => expect(screen.getByTitle("Agent computer live view").getAttribute("src")).toContain("ticket=2"));
});

it("requires fresh passkey verification before releasing the kill switch", async () => {
  let released = false;
  vi.mocked(startAuthentication).mockResolvedValue({ id: "fresh-check" } as Awaited<ReturnType<typeof startAuthentication>>);
  handler = path => {
    if (path === `/api/agents/${agentId}`) return json({ ...agent, computer: { ...agent.computer, state: released ? "stopped" : "killed", killedAt: released ? null : at } });
    if (path === "/api/auth/fresh/options") return json({ challenge: "abc", userVerification: "required" });
    if (path === "/api/auth/fresh/verify") return json({ freshUntil: "2026-10-17T12:00:00.000Z" });
    if (path === `/api/agents/${agentId}/kill/release`) { released = true; return json(agent.computer); }
    return undefined;
  };
  renderApp(`/agents/${agentId}/computer`);
  fireEvent.click(await screen.findByRole("button", { name: "Release kill switch" }));
  await waitFor(() => expect(released).toBe(true));
  const paths = fetchMock.mock.calls.map(([url]) => String(url));
  expect(paths.indexOf("/api/auth/fresh/options")).toBeLessThan(paths.indexOf("/api/auth/fresh/verify"));
  expect(paths.indexOf("/api/auth/fresh/verify")).toBeLessThan(paths.indexOf(`/api/agents/${agentId}/kill/release`));
  expect(requestBody("/api/auth/fresh/verify")).toEqual({ response: { id: "fresh-check" } });
});

it("keeps the kill switch engaged when fresh passkey verification fails", async () => {
  vi.mocked(startAuthentication).mockRejectedValue(new Error("Passkey check cancelled"));
  handler = path => {
    if (path === `/api/agents/${agentId}`) return json({ ...agent, computer: { ...agent.computer, state: "killed", killedAt: at } });
    if (path === "/api/auth/fresh/options") return json({ challenge: "abc" });
    return undefined;
  };
  renderApp(`/agents/${agentId}/computer`);
  fireEvent.click(await screen.findByRole("button", { name: "Release kill switch" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Passkey check cancelled");
  expect(fetchMock.mock.calls.some(([url]) => url === `/api/agents/${agentId}/kill/release`)).toBe(false);
});

it("shows a streamed owner request as an actionable card before the next poll", async () => {
  const takeover = { ...ownerRequest, kind: "takeover" as const, whatToDo: "Confirm the invoice download" };
  let requested = false;
  handler = path => {
    if (path === `/api/tasks/${taskId}`) return json({ ...detail, openRequests: requested ? [takeover] : [] });
    if (path === `/api/tasks/${taskId}/takeover-done`) return json(task);
    return undefined;
  };
  const source = await openChat();
  requested = true;
  act(() => source.emit(1, { kind: "owner_request", request: takeover }));
  expect(await screen.findByText("Take over the browser")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "I'm done, continue" }));
  await waitFor(() => expect(screen.queryByText("Take over the browser")).toBeNull());
  expect(requestBody(`/api/tasks/${taskId}/takeover-done`)).toEqual({ note: "" });
});

it("routes an unauthorized download to sign-in", async () => {
  handler = path => {
    if (path === `/api/tasks/${taskId}`) return json({ ...detail, task: { ...task, state: "completed", result: { summary: "Saved", files: [{ fileId: domainRequestId, name: "invoice.pdf", bytes: 20, sha256: hash, scope: "downloads" }] } } });
    if (path === `/api/files/${domainRequestId}/content`) return json({ error: { code: "signed_out", message: "Session expired" } }, 401);
    return undefined;
  };
  await openChat();
  const attachment = screen.getByText("invoice.pdf").closest<HTMLElement>(".attachment");
  if (!attachment) throw new Error("No result attachment");
  expect(within(attachment).getByText("20 B · downloads")).toBeTruthy();
  fireEvent.click(within(attachment).getByRole("link", { name: "Download" }));
  expect(await screen.findByRole("button", { name: "Sign in with passkey" })).toBeTruthy();
});

it("keeps the setup ticket in POST bodies and removes its fragment", async () => {
  const ticket = "s".repeat(40);
  window.history.replaceState(null, "", `/setup#${ticket}`);
  vi.mocked(startRegistration).mockResolvedValue({ id: "registration" } as Awaited<ReturnType<typeof startRegistration>>);
  handler = path => {
    if (path === "/api/setup/options") return json({ challenge: "abc", rp: { name: "Quokka Bot" }, user: { id: "abc", name: "Owner", displayName: "Owner" }, pubKeyCredParams: [{ alg: -7, type: "public-key" }] });
    if (path === "/api/setup/verify") return json(me);
    return undefined;
  };
  renderApp("/setup");
  fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.getByLabelText("App route").textContent).toBe(`/agents/${agentId}`);
  expect(window.location.hash).toBe("");
  expect(requestBody("/api/setup/options")).toEqual({ ticket });
  expect(requestBody("/api/setup/verify")).toEqual({ ticket, response: { id: "registration" } });
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes(ticket))).toBe(false);
});

it.each([
  ["Logins", "logins", "Logins"],
  ["Allowed sites", "domains", "Domains"],
  ["Activity log", "audit", "Audit"],
  ["Agent settings", "settings", "Settings"],
  ["Open computer", "computer", "Computer"],
  ["Terminal", "terminal", "Terminal"],
] as const)("reaches %s from the details panel and returns to chat", async (link, section, heading) => {
  await openChat();
  const panel = screen.getByRole("complementary", { name: `${agent.name} details` });
  if (section === "computer" || section === "terminal") fireEvent.click(within(panel).getByRole("tab", { name: "Computer" }));
  const destination = within(panel).getByRole("link", { name: new RegExp(`^${link}`) });
  expect(destination.getAttribute("href")).toBe(`/agents/${agentId}/${section}`);
  fireEvent.click(destination);
  expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
  expect(screen.getByLabelText("App route").textContent).toBe(`/agents/${agentId}/${section}`);
  fireEvent.click(screen.getByRole("link", { name: "‹ Chat" }));
  expect(await screen.findByRole("textbox", { name: "Message" })).toBeTruthy();
});

it("opens the Library tab in the panel", async () => {
  await openChat();
  const panel = screen.getByRole("complementary", { name: `${agent.name} details` });
  fireEvent.click(within(panel).getByRole("tab", { name: "Library" }));
  expect(within(panel).getByRole("tab", { name: "Library" }).getAttribute("aria-selected")).toBe("true");
  expect(await within(panel).findByRole("heading", { name: "Downloads" })).toBeTruthy();
  expect(within(panel).getByRole("heading", { name: "Workspace" })).toBeTruthy();
});

it.each([
  ["computer", "Computer"], ["terminal", "Terminal"], ["files", "Files"], ["logins", "Logins"],
  ["domains", "Domains"], ["audit", "Audit"], ["settings", "Settings"],
] as const)("opens the %s section route directly", async (section, heading) => {
  renderApp(`/agents/${agentId}/${section}`);
  expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
  expect(screen.getByRole("link", { name: "‹ Chat" }).getAttribute("href")).toBe(`/agents/${agentId}`);
});

it("opens owner settings from the sidebar", async () => {
  await openChat();
  fireEvent.click(screen.getByRole("link", { name: "Settings" }));
  expect(await screen.findByRole("heading", { name: "Signed-in devices" })).toBeTruthy();
  expect(screen.getByLabelText("App route").textContent).toBe("/settings");
});

it("refuses a workspace path outside its root before fetching", () => {
  expect(() => api.files(agentId, "workspace", "../secret")).toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});

describe("chat composer", () => {
  it.each(["no tasks", "new=1"] as const)("creates and selects a task with %s", async mode => {
    const created = { ...task, id: domainRequestId, title: "Collect November invoices" };
    let submitted = false;
    handler = (path, init) => {
      if (path === `/api/agents/${agentId}/tasks?`) return json({ tasks: submitted ? [created, task] : mode === "no tasks" ? [] : [task], nextBefore: null });
      if (path === `/api/agents/${agentId}/tasks` && init?.method === "POST") { submitted = true; return json(created); }
      if (path === `/api/tasks/${created.id}`) return json({ ...detail, task: created });
      return undefined;
    };
    renderApp(`/agents/${agentId}${mode === "new=1" ? "?new=1" : ""}`);
    if (mode === "no tasks") await screen.findByRole("heading", { name: agent.name, level: 1 });
    else await screen.findByText("New task", { selector: "p" });
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "New task" });
    expect(composer.disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(true);
    fireEvent.change(composer, { target: { value: "   " } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(true);
    fireEvent.change(composer, { target: { value: "  Collect November invoices  " } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(composer.value).toBe(""));
    expect(requestBody(`/api/agents/${agentId}/tasks`)).toEqual({ prompt: created.title, attachmentIds: [] });
    // React Router applies navigation as a transition, which can land a render after the composer clears.
    await waitFor(() => expect(screen.getByLabelText("App route").textContent).toBe(`/agents/${agentId}?task=${created.id}`));
    await screen.findByRole("button", { name: "Stop" });
    expect(MockEventSource.instances.at(-1)?.url).toBe(`/api/tasks/${created.id}/events?after=0`);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/reply") || String(url).endsWith("/message"))).toBe(false);
  });

  it.each(["completed", "failed", "cancelled"] as const)("sends a follow-up for a %s task without creating another task", async state => {
    let sent = false;
    handler = path => {
      if (path === `/api/tasks/${taskId}`) return json({ ...detail, task: { ...task, state: sent ? "running" : state } });
      if (path === `/api/tasks/${taskId}/message`) { sent = true; return json(task); }
      return undefined;
    };
    await openChat();
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    expect(composer.disabled).toBe(false);
    fireEvent.change(composer, { target: { value: "  Also collect November  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(composer.value).toBe(""));
    expect(requestBody(`/api/tasks/${taskId}/message`)).toEqual({ text: "Also collect November", attachmentIds: [] });
    expect(fetchMock.mock.calls.some(([url, init]) => url === `/api/agents/${agentId}/tasks` && init?.method === "POST")).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/reply"))).toBe(false);
  });

  it("keeps Shift+Enter for a newline and sends on Enter", async () => {
    handler = path => {
      if (path === `/api/tasks/${taskId}`) return json({ ...detail, task: { ...task, state: "completed" } });
      if (path === `/api/tasks/${taskId}/message`) return json(task);
      return undefined;
    };
    await openChat();
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "First line" } });
    expect(fireEvent.keyDown(composer, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/message"))).toBe(false);
    // fireEvent does not insert the browser's default newline, so apply its resulting value.
    fireEvent.change(composer, { target: { value: "First line\nSecond line" } });
    expect(fireEvent.keyDown(composer, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(requestBody(`/api/tasks/${taskId}/message`)).toEqual({ text: "First line\nSecond line", attachmentIds: [] }));
  });

  it("disables input for a running task and posts Stop once", async () => {
    let cancelled = false;
    handler = path => {
      if (path === `/api/tasks/${taskId}`) return json({ ...detail, task: { ...task, state: cancelled ? "cancelled" : "running" } });
      if (path === `/api/tasks/${taskId}/cancel`) { cancelled = true; return json({ ...task, state: "cancelled" }); }
      return undefined;
    };
    await openChat();
    const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    expect(composer.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(composer.disabled).toBe(false));
    expect(requestBody(`/api/tasks/${taskId}/cancel`)).toEqual({});
    expect(fetchMock.mock.calls.filter(([url]) => url === `/api/tasks/${taskId}/cancel`)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it.each(["sidebar", "composer"] as const)("starts a new task from the %s and focuses its composer", async location => {
    await openChat();
    const container = location === "sidebar"
      ? screen.getByRole("navigation", { name: "Agents" }).closest("aside")
      : screen.getByRole("textbox", { name: "Message" }).closest("form");
    if (!container) throw new Error(`No ${location} container`);
    fireEvent.click(within(container).getByRole("button", { name: "New task" }));
    const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "New task" });
    expect(screen.getByLabelText("App route").textContent).toBe(`/agents/${agentId}?new=1`);
    expect(composer.disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });
});

it("redirects a legacy task URL to its agent and selects that task instead of the newest", async () => {
  const newest = { ...task, id: domainRequestId, title: "Newest task" };
  handler = path => path === `/api/agents/${agentId}/tasks?` ? json({ tasks: [newest, task], nextBefore: null }) : undefined;
  const source = await openChat(`/tasks/${taskId}`);
  expect(screen.getByLabelText("App route").textContent).toBe(`/agents/${agentId}?task=${taskId}`);
  expect(source.url).toBe(`/api/tasks/${taskId}/events?after=0`);
  expect(screen.getByRole("link", { name: "Back to the latest task" }).getAttribute("href")).toBe(`/agents/${agentId}`);
});

it("shows earlier tasks as exchanges and opens their full chat", async () => {
  const older = { ...task, id: domainRequestId, title: "Collect September invoices", state: "completed", result: { summary: "September saved", files: [] } };
  handler = path => {
    if (path === `/api/agents/${agentId}/tasks?`) return json({ tasks: [task, older], nextBefore: null });
    if (path === `/api/tasks/${older.id}`) return json({ ...detail, task: older });
    return undefined;
  };
  const source = await openChat();
  expect(screen.getByText(older.title)).toBeTruthy();
  expect(screen.getByText(older.result.summary)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open this task" }));
  await waitFor(() => expect(MockEventSource.instances).toHaveLength(2));
  expect(source.closed).toBe(true);
  expect(MockEventSource.instances[1]?.url).toBe(`/api/tasks/${older.id}/events?after=0`);
  expect(screen.getByLabelText("App route").textContent).toBe(`/agents/${agentId}?task=${older.id}`);
});

it("keeps one answer per run and folds the agent's lines between tools into the steps", async () => {
  const source = await openChat();
  act(() => {
    source.emit(1, { kind: "owner_message", text: "Please get the invoice", attachments: [] });
    source.emit(2, { kind: "assistant_text", text: "Opening the billing site" });
    source.emit(3, { kind: "tool_call", tool: "browser_download", summary: "Save invoice" });
    source.emit(4, { kind: "tool_result", tool: "browser_download", status: "ok", summary: "Invoice saved" });
  });
  expect(screen.getByText("Please get the invoice").closest(".bubble")?.classList.contains("owner")).toBe(true);
  // A line followed by more work is not a message: it is the live status while the agent works.
  expect(document.querySelectorAll(".bubble.agent")).toHaveLength(0);
  expect(screen.getByRole("status", { name: "Opening the billing site" })).toBeTruthy();
  act(() => source.emit(5, { kind: "assistant_text", text: "The invoice is in Downloads." }));
  expect(document.querySelectorAll(".bubble.agent")).toHaveLength(1);
  expect(screen.getByText("The invoice is in Downloads.").closest(".bubble")?.classList.contains("agent")).toBe(true);
  const steps = screen.getByRole("button", { name: /2 steps/ });
  expect(steps.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
  fireEvent.click(steps);
  expect(steps.getAttribute("aria-expanded")).toBe("true");
  expect(within(screen.getByRole("list")).getAllByRole("listitem").map(item => item.textContent)).toEqual([
    "Opening the billing site", "browser_download · Save invoice", "browser_download · ok · Invoice saved",
  ]);
  fireEvent.click(steps);
  expect(screen.queryByRole("list")).toBeNull();
});

it("folds the line before a card, keeps the answer after it, and shows a run's last line when it ended on work", () => {
  const events = [
    { kind: "owner_message", text: "Check the stats", attachments: [] },
    { kind: "run", run: { ...run, state: "starting" } },
    { kind: "assistant_text", text: "Sending you the login form." },
    { kind: "owner_request", request: { ...ownerRequest, kind: "login", site: "roblox.com", loginName: "Roblox" } },
    { kind: "tool_call", tool: "request_login", summary: "request_login" },
    { kind: "assistant_text", text: "I need your Roblox login." },
    { kind: "run", run: { ...run, state: "exited" } },
    { kind: "run", run: { ...run, state: "starting" } },
    { kind: "assistant_text", text: "Signed in. Pulling the stats." },
    { kind: "tool_call", tool: "browser_open", summary: "browser_open" },
    { kind: "run", run: { ...run, state: "exited" } },
  ] as const;
  const items = chatItems(events.map((event, index) => ({ taskId: taskId as never, seq: index + 1, at, event: event as never })));
  expect(items.map(item => item.kind === "agent" ? `agent: ${item.text}` : item.kind === "steps" ? `steps: ${item.lines.map(line => line.text).join(" | ")}` : item.kind))
    .toEqual([
      "owner",
      "steps: Sending you the login form.",
      "request",
      "steps: request_login · request_login",
      "agent: I need your Roblox login.",
      "steps: browser_open · browser_open",
      "agent: Signed in. Pulling the stats.",
    ]);
});

describe("message reactions", () => {
  it("offers six choices after text is final and posts to the final event, keeping the draft bubble", async () => {
    const path = `/api/tasks/${taskId}/events/4/reaction`;
    const accepted = Promise.withResolvers<Response>();
    handler = url => url === path ? accepted.promise : undefined;
    const source = await openChat();
    act(() => {
      source.emit(1, { kind: "owner_message", text: "Get the invoice", attachments: [] });
      source.emit(2, { kind: "assistant_delta", text: "Opening " });
      source.emit(3, { kind: "assistant_delta", text: "billing" });
    });
    const draft = screen.getByText("Opening billing").closest(".bubble");
    expect(screen.queryByRole("button", { name: "React" })).toBeNull();
    act(() => source.emit(4, { kind: "assistant_text", text: "Saved the invoice." }));
    expect(screen.getByText("Saved the invoice.").closest(".bubble")).toBe(draft);
    fireEvent.click(screen.getByRole("button", { name: "React" }));
    const picker = screen.getByRole("dialog", { name: "Choose a reaction" });
    expect(within(picker).getAllByRole("button").map(button => button.textContent)).toEqual([...REACTION_EMOJIS]);
    expect(document.activeElement).toBe(within(picker).getByRole("button", { name: "React 👍" }));
    fireEvent.click(within(picker).getByRole("button", { name: "React ❤️" }));
    await waitFor(() => expect(requestBody(path)).toEqual({ emoji: "❤️" }));
    await waitFor(() => expect(within(picker).getAllByRole<HTMLButtonElement>("button").every(button => button.disabled)).toBe(true));
    await act(async () => accepted.resolve(json({})));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => source.emit(5, { kind: "reaction", targetSeq: 4, by: "owner", emoji: "❤️" }));
    expect(screen.getByRole("img", { name: "Your reaction: ❤️" }).closest(".bubble")).toBe(draft);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "React" }));
  });

  it("removes the selected emoji with null, and replayed replacements and removals win", async () => {
    const path = `/api/tasks/${taskId}/events/1/reaction`;
    handler = url => url === path ? json({}) : undefined;
    const source = await openChat();
    act(() => {
      source.emit(1, { kind: "assistant_text", text: "Done." });
      source.emit(2, { kind: "reaction", targetSeq: 1, by: "owner", emoji: "👍" });
      source.emit(3, { kind: "reaction", targetSeq: 1, by: "owner", emoji: "✅" });
    });
    expect(screen.queryByRole("img", { name: "Your reaction: 👍" })).toBeNull();
    expect(screen.getByRole("img", { name: "Your reaction: ✅" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "React" }));
    const selected = screen.getByRole("button", { name: "React ✅" });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(selected);
    await waitFor(() => expect(requestBody(path)).toEqual({ emoji: null }));
    act(() => source.emit(4, { kind: "reaction", targetSeq: 1, by: "owner", emoji: null }));
    expect(screen.queryByRole("img", { name: /Your reaction/ })).toBeNull();
  });

  it("folds live agent reactions onto the targeted owner bubble independently of owner reactions", async () => {
    const source = await openChat();
    act(() => {
      source.emit(1, { kind: "owner_message", text: "Thank you", attachments: [] });
      source.emit(2, { kind: "assistant_text", text: "All saved." });
      source.emit(3, { kind: "owner_message", text: "Also November", attachments: [] });
      source.emit(4, { kind: "reaction", targetSeq: 1, by: "agent", emoji: "👍" });
      source.emit(5, { kind: "reaction", targetSeq: 2, by: "owner", emoji: "🎉" });
    });
    expect(screen.getByRole("img", { name: "Agent reaction: 👍" }).closest(".bubble")).toBe(screen.getByText("Thank you").closest(".bubble"));
    act(() => source.emit(6, { kind: "reaction", targetSeq: 1, by: "agent", emoji: "👀" }));
    expect(screen.queryByRole("img", { name: "Agent reaction: 👍" })).toBeNull();
    expect(screen.getByRole("img", { name: "Agent reaction: 👀" })).toBeTruthy();
    act(() => source.emit(7, { kind: "reaction", targetSeq: 1, by: "agent", emoji: null }));
    expect(screen.queryByRole("img", { name: /Agent reaction/ })).toBeNull();
    expect(screen.getByRole("img", { name: "Your reaction: 🎉" })).toBeTruthy();
  });

  it("reacts to questions and closes the picker with Escape, returning keyboard focus", async () => {
    const path = `/api/tasks/${taskId}/events/1/reaction`;
    handler = url => url === path ? json({}) : undefined;
    const source = await openChat();
    act(() => source.emit(1, { kind: "owner_request", request: ownerRequest }));
    const trigger = screen.getByRole("button", { name: "React" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("button", { name: "React 👍" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "React 😂" }));
    await waitFor(() => expect(requestBody(path)).toEqual({ emoji: "😂" }));
  });

  it("shows a failed reaction request without inventing a badge", async () => {
    const path = `/api/tasks/${taskId}/events/1/reaction`;
    handler = url => url === path ? json({ error: { code: "unknown_event", message: "No such message in this task." } }, 404) : undefined;
    const source = await openChat();
    act(() => source.emit(1, { kind: "assistant_text", text: "Saved." }));
    fireEvent.click(screen.getByRole("button", { name: "React" }));
    fireEvent.click(screen.getByRole("button", { name: "React 👍" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "No such message in this task.");
    expect(screen.queryByRole("img", { name: /Your reaction/ })).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
  });
});

it("polls agents and inbox every five seconds and pauses when hidden", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.useFakeTimers();
  try {
    const view = renderApp(`/agents/${agentId}`);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    fetchMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/agents")).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/inbox")).toBe(true);
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    fetchMock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/agents" || url === "/api/inbox")).toBe(false);
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/agents")).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/inbox")).toBe(true);
    view.unmount();
  } finally { vi.useRealTimers(); visibility.mockRestore(); }
});
