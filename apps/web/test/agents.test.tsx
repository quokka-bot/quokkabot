import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "@quokkabot/shared";
import { App } from "../src/app.js";
import { agentColour } from "../src/avatar.js";
import { agentCapacityMessage } from "../src/agent-dialog.js";
import { agent, agentId, json, me, taskId } from "./fixtures.js";

const secondId = "66666666-6666-4666-8666-666666666666";
const second: AgentSummary = { ...agent, id: secondId as AgentSummary["id"], index: 2, name: "Agent 2", cliSignedIn: "no" };
let agents: AgentSummary[];
let total: number;
let client: QueryClient;
// Agent reads that never answer, to show what the window shows before its next poll.
let holdAgentReads: boolean;
let settingsFailure: { status: number; code: string; message: string } | null;
const fetchMock = vi.fn<typeof fetch>();
function Location() { const location = useLocation(); return <output aria-label="Route">{location.pathname}</output>; }
function open(path = `/agents/${agentId}`) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter></QueryClientProvider>);
}
// The sidebar has two: the + beside search and the New agent button under the list.
async function openNewAgent(which: "top" | "list" = "list") {
  const buttons = await screen.findAllByRole("button", { name: "New agent" });
  expect(buttons).toHaveLength(2);
  const button = which === "top" ? buttons[0] : buttons[1];
  if (!button) throw new Error(`No ${which} New agent button`);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}
beforeEach(() => {
  agents = [{ ...agent }]; total = 3; holdAgentReads = false; settingsFailure = null;
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (holdAgentReads && method === "GET" && /^\/api\/agents(\/[^/]+)?$/.test(path)) return new Promise<Response>(() => undefined);
    if (path === "/api/me") return json(me);
    if (path === "/api/agents") {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as { name: string };
        const created = { ...second, name: body.name };
        agents.push(created);
        return json(created, 201);
      }
      return json({ agents, capacity: { used: agents.length, total } });
    }
    if (path === "/api/sessions") return json({ sessions: [] });
    const match = /^\/api\/agents\/([^/]+)(.*)$/.exec(path);
    if (match) {
      const item = agents.find(agent => agent.id === match[1]);
      if (!item) return json({ error: { code: "unknown_agent", message: "No such agent." } }, 404);
      if (match[2] === "") {
        if (method === "DELETE") { agents = agents.filter(agent => agent.id !== item.id); return json({}); }
        return json(item);
      }
      if (match[2] === "/settings") {
        if (settingsFailure) return json({ error: { code: settingsFailure.code, message: settingsFailure.message } }, settingsFailure.status);
        const values = JSON.parse(String(init?.body)) as { name: string; model: string; effort: AgentSummary["effort"] };
        Object.assign(item, values);
        return json(item);
      }
      if (match[2]?.startsWith("/tasks?")) return json({ tasks: [], nextBefore: null });
      if (match[2] === "/logins") return json({ logins: [] });
      if (match[2] === "/connectors") return json({ connectors: [], available: { gmail: false } });
      if (match[2] === "/ai-consent" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { allow: boolean };
        item.aiConsent = { ...item.aiConsent!, state: body.allow ? "granted" : "withdrawn", allowed: body.allow, changedAt: "2026-10-20T09:00:00.000Z", changedBy: { client: "browser", deviceName: "Browser" } };
        return json(item.aiConsent);
      }
    }
    throw new Error(`Unexpected fetch ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); });

describe("agent lifecycle UI", () => {
  it("prefills the lowest free slot, creates and navigates to its chat", async () => {
    open();
    client.setQueryData(["old-slot-data", secondId], "old secrets");
    await openNewAgent();
    const dialog = screen.getByRole("dialog", { name: "New agent" });
    const input = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(input.value).toBe("Agent 2");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "  Billing  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByLabelText("Route").textContent).toBe(`/agents/${secondId}`));
    expect(fetchMock.mock.calls.find(([url, init]) => url === "/api/agents" && init?.method === "POST")?.[1]?.body).toBe(JSON.stringify({ name: "Billing" }));
    expect(client.getQueryData(["old-slot-data", secondId])).toBeUndefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens New agent from the + beside search", async () => {
    open();
    await openNewAgent("top");
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeTruthy();
    expect(screen.getByLabelText("Route").textContent).toBe(`/agents/${agentId}`);
  });
  it("uses a hole in the slots for the suggested name", async () => {
    agents = [{ ...agent, index: 2 }];
    open();
    await openNewAgent();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Agent 1");
  });
  it("keeps New agent visible and shows the capacity message when full", async () => {
    total = 1;
    open();
    await openNewAgent();
    const dialog = screen.getByRole("dialog", { name: "New agent" });
    expect(within(dialog).getByText(agentCapacityMessage(1))).toBeTruthy();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Create" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("saves a trimmed name using the settings form and refreshes the sidebar", async () => {
    open(`/agents/${agentId}/settings`);
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "  Invoices  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved.");
    const request = fetchMock.mock.calls.find(([url, init]) => url === `/api/agents/${agentId}/settings` && init?.method === "PUT");
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ name: "Invoices" });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Agents" }).textContent).toContain("Invoices"));
  });
  it("turns sending to the AI provider off at once, and on only through the permission card", async () => {
    open(`/agents/${agentId}/settings`);
    const toggle = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Send to Claude by Anthropic" });
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    const off = fetchMock.mock.calls.find(([url, init]) => url === `/api/agents/${agentId}/ai-consent` && init?.method === "PUT");
    expect(JSON.parse(String(off?.[1]?.body))).toEqual({ allow: false, provider: "anthropic" });
    expect(await screen.findByText(/^Turned off .* in the web app on Browser\.$/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Allow for Office" }));
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(screen.queryByRole("heading", { name: "Office works with Claude by Anthropic" })).toBeNull();
  });
  it("requires confirmation, removes an agent, drops its chat cache and redirects to the next agent", async () => {
    agents.push(second);
    open(`/agents/${agentId}/settings`);
    client.setQueryData(["task", taskId], { private: "old transcript" });
    fireEvent.click(await screen.findByRole("button", { name: "Remove agent" }));
    const dialog = screen.getByRole("dialog", { name: `Remove ${agent.name}?` });
    expect(within(dialog).getByText("Its chats, files, saved logins and connected apps are deleted. This cannot be undone.")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByLabelText("Route").textContent).toBe(`/agents/${secondId}`));
    expect(client.getQueryData(["task", taskId])).toBeUndefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("cancel leaves the agent in place", async () => {
    open(`/agents/${agentId}/settings`);
    fireEvent.click(await screen.findByRole("button", { name: "Remove agent" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  it("removing the final agent opens the centred first-agent form", async () => {
    open(`/agents/${agentId}/settings`);
    fireEvent.click(await screen.findByRole("button", { name: "Remove agent" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByLabelText("Route").textContent).toBe("/"));
    expect(await screen.findByRole("heading", { name: "New agent" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Agent 1");
  });
  it("shows the same form when the server has no added agents", async () => {
    agents = [];
    open("/");
    await screen.findByRole("heading", { name: "New agent" });
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Agent 1");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByLabelText("Route").textContent).toBe(`/agents/${secondId}`));
  });
  it("keeps every slot's avatar colour distinct", () => {
    expect(new Set(Array.from({ length: 99 }, (_, index) => agentColour(index + 1))).size).toBe(99);
    expect(agentColour(2)).not.toBe(agentColour(1));
  });
});

describe("renaming in the details panel", () => {
  const settingsRequests = () => fetchMock.mock.calls.filter(([url, init]) => url === `/api/agents/${agentId}/settings` && init?.method === "PUT");
  async function startRename() {
    const button = await screen.findByRole("button", { name: "Rename Office" });
    // A native button: Tab reaches it, and Enter or Space press it.
    expect(button.tagName).toBe("BUTTON");
    expect(button.closest("h2")).toBeTruthy();
    fireEvent.click(button);
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Agent name" });
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, "Office".length]);
    return field;
  }

  it("saves a trimmed name with Enter and shows it in the sidebar, title and composer before the next poll", async () => {
    open();
    const field = await startRename();
    fireEvent.change(field, { target: { value: "  Invoices  " } });
    holdAgentReads = true;
    fireEvent.submit(field);
    const renamed = await screen.findByRole("button", { name: "Rename Invoices" });
    expect(document.activeElement).toBe(renamed);
    expect(JSON.parse(String(settingsRequests()[0]?.[1]?.body))).toEqual({ name: "Invoices" });
    expect(within(screen.getByRole("navigation", { name: "Agents" })).getByText("Invoices")).toBeTruthy();
    expect(document.querySelector(".title-pill")?.textContent).toBe("Invoices");
    expect(screen.getByRole("textbox", { name: "New task" }).getAttribute("placeholder")).toBe("New task for Invoices");
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("Name saved.");
  });
  it("saves when the field loses focus and leaves focus where it went", async () => {
    open();
    const field = await startRename();
    fireEvent.change(field, { target: { value: "Receipts" } });
    const close = screen.getByRole("button", { name: "Close details" });
    act(() => close.focus());
    await screen.findByRole("button", { name: "Rename Receipts" });
    expect(document.activeElement).toBe(close);
    expect(settingsRequests()).toHaveLength(1);
  });
  it("keeps the old name on Escape and sends nothing", async () => {
    open();
    const field = await startRename();
    fireEvent.change(field, { target: { value: "Receipts" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename Office" }));
    expect(screen.queryByRole("textbox", { name: "Agent name" })).toBeNull();
    expect(settingsRequests()).toHaveLength(0);
  });
  it("closes without a request when the name is unchanged", async () => {
    open();
    const field = await startRename();
    fireEvent.change(field, { target: { value: " Office " } });
    fireEvent.submit(field);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename Office" }));
    expect(settingsRequests()).toHaveLength(0);
  });
  it("refuses an empty or a 41-character name in place and sends nothing", async () => {
    open();
    const field = await startRename();
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.submit(field);
    expect(screen.getByRole("alert").textContent).toBe("Type a name.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
    fireEvent.change(field, { target: { value: "x".repeat(41) } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(field);
    expect(screen.getByRole("alert").textContent).toBe("Use 40 characters or fewer.");
    expect(field.value).toBe("x".repeat(41));
    expect(settingsRequests()).toHaveLength(0);
  });
  it("shows a refused save next to the field and keeps the typed name", async () => {
    settingsFailure = { status: 409, code: "agent_removing", message: "This agent is being removed." };
    open();
    const field = await startRename();
    fireEvent.change(field, { target: { value: "Invoices" } });
    fireEvent.submit(field);
    expect((await screen.findByRole("alert")).textContent).toBe("This agent is being removed.");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Agent name" }).value).toBe("Invoices");
    expect(screen.getByRole("navigation", { name: "Agents" }).textContent).toContain("Office");
  });
  it("shows a panel rename in an untouched settings form, so Save keeps it", async () => {
    open(`/agents/${agentId}/settings`);
    const name = await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" });
    const field = await startRename();
    fireEvent.change(field, { target: { value: "Invoices" } });
    fireEvent.submit(field);
    await screen.findByRole("button", { name: "Rename Invoices" });
    expect(name.value).toBe("Invoices");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved.");
    expect(JSON.parse(String(settingsRequests()[1]?.[1]?.body))).toMatchObject({ name: "Invoices" });
  });
});
