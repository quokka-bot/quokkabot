import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  agents = [{ ...agent }]; total = 3;
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
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
