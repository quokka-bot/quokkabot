import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSummary } from "@quokkabot/shared";
import { ClaudeSetting, ClaudeSignInCard } from "../src/claude-sign-in.js";
import { AgentChat } from "../src/chat.js";
import { api } from "../src/api.js";
import { agent, task, detail, emptyDomains } from "./fixtures.js";

const signedOut = { ...agent, cliSignedIn: "no" as const };
const signInId = "44444444-4444-4444-8444-444444444444";
const url = "https://claude.com/cai/oauth/authorize?state=abcdefgh";
const code = "abcdefgh_1234#state_abcdefgh";
const view = { signedIn: true, signedInAt: "2026-10-20T10:00:00.000Z" };
const signedInText = "Signed in to Claude. Every agent works on this sign-in.";
let client: QueryClient;
let tab: { closed: boolean; opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };

function mount(content = <ClaudeSignInCard agent={signedOut} />) {
  return render(<QueryClientProvider client={client}><MemoryRouter>{content}</MemoryRouter></QueryClientProvider>);
}
function paste(value: string) {
  fireEvent.paste(screen.getByLabelText("Paste the code from the Claude page"), { clipboardData: { getData: () => value } });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  tab = { closed: false, opener: {}, location: { href: "" }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  vi.spyOn(api, "startClaudeSignIn").mockResolvedValue({ signInId, url });
  vi.spyOn(api, "submitClaudeSignIn").mockResolvedValue(view);
  vi.spyOn(api, "cancelClaudeSignIn").mockResolvedValue({});
});
afterEach(() => { client.clear(); vi.restoreAllMocks(); });

describe("Claude sign-in card", () => {
  it("opens a tab during the click, shows computer startup, pastes and submits once, then signs in every agent", async () => {
    let finishStart!: (value: { signInId: string; url: string }) => void;
    vi.mocked(api.startClaudeSignIn).mockImplementation(() => new Promise(resolve => { finishStart = resolve; }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Open Claude sign-in" }));
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    expect(screen.getByRole("status").textContent).toBe("Starting the agent's computer…");
    finishStart({ signInId, url });
    await screen.findByLabelText("Paste the code from the Claude page");
    expect(tab.location.href).toBe(url);
    expect(tab.opener).toBeNull();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    paste(code);
    await screen.findByText(signedInText);
    expect(api.submitClaudeSignIn).toHaveBeenCalledExactlyOnceWith(signInId, code);
    expect(screen.queryByRole("region", { name: "Sign in to Claude" })).toBeNull();
    // Every agent's summary changes, not only this agent's.
    await vi.waitFor(() => expect(invalidate.mock.calls.map(call => call[0]?.queryKey)).toEqual([["claude-sign-in"], ["agent"], ["agents"]]));
  });

  it("keeps failures in the card and starts a fresh login on Start again", async () => {
    vi.mocked(api.submitClaudeSignIn).mockRejectedValueOnce(new Error("Login failed: Request failed with status code 400"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Open Claude sign-in" }));
    await screen.findByLabelText("Paste the code from the Claude page");
    paste(code);
    expect((await screen.findByRole("alert")).textContent).toBe("Login failed: Request failed with status code 400");
    expect(screen.queryByDisplayValue(code)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    await screen.findByLabelText("Paste the code from the Claude page");
    expect(api.startClaudeSignIn).toHaveBeenCalledTimes(2);
    paste(code);
    await screen.findByText(signedInText);
  });

  it("closes the blank tab when starting fails and offers Start again", async () => {
    vi.mocked(api.startClaudeSignIn).mockRejectedValueOnce(new Error("Wait for the current task to finish"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Open Claude sign-in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wait for the current task to finish");
    expect(tab.close).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start again" })).not.toBeNull();
  });

  it("supports typing and Finish sign-in, and cancels an abandoned login", async () => {
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "Open Claude sign-in" }));
    const input = await screen.findByLabelText("Paste the code from the Claude page");
    fireEvent.change(input, { target: { value: code } });
    expect(api.submitClaudeSignIn).not.toHaveBeenCalled();
    view.unmount();
    expect(api.cancelClaudeSignIn).toHaveBeenCalledWith(signInId);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Open Claude sign-in" }));
    fireEvent.change(await screen.findByLabelText("Paste the code from the Claude page"), { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }));
    await screen.findByText(signedInText);
  });

  it("says one sign-in serves every agent and offers no per-agent terminal sign-in", () => {
    mount();
    expect(screen.getByText("Your agents work on your Claude plan. Sign in once and every agent uses it.")).not.toBeNull();
    expect(screen.queryByText(/terminal/i)).toBeNull();
  });
});

describe("Claude setting", () => {
  it("shows the shared sign-in and signs every agent out after confirmation", async () => {
    vi.spyOn(api, "claudeSignIn").mockResolvedValueOnce(view).mockResolvedValue({ signedIn: false, signedInAt: null });
    vi.spyOn(api, "signOutClaude").mockResolvedValue({ signedIn: false, signedInAt: null });
    mount(<ClaudeSetting />);
    expect(await screen.findByText("Every agent works on your Claude plan.")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out of Claude" }));
    expect(api.signOutClaude).not.toHaveBeenCalled();
    // An agent's own terminal sign-in is not part of this sign-out.
    expect(screen.getByText(/An agent signed in from its own terminal keeps working; the others need a new sign-in\./)).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Sign in to Claude from any agent's chat. Every agent then uses that sign-in.")).not.toBeNull();
    expect(api.signOutClaude).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

class EventSourceStub { onmessage = null; onerror = null; onopen = null; close() {} }

describe("sign-in placement in chat", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", EventSourceStub);
    vi.spyOn(api, "domains").mockResolvedValue(emptyDomains);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("replaces the greeting for a signed-out new agent and leaves the composer usable", async () => {
    vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [], nextBefore: null });
    mount(<AgentChat agent={signedOut} index={0} />);
    expect(await screen.findByRole("region", { name: "Sign in to Claude" })).not.toBeNull();
    expect(screen.queryByText(/Give Office a task/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "New task" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows the card for a task that failed signed out, then offers retry once signed in", async () => {
    const failed = { ...task, state: "failed" as const, error: "Claude Code is signed out. Sign in to Claude, then try again." };
    vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [failed], nextBefore: null });
    vi.spyOn(api, "task").mockResolvedValue({ ...detail, task: failed });
    const view = mount(<AgentChat agent={signedOut} index={0} />);
    expect(await screen.findByRole("region", { name: "Sign in to Claude" })).not.toBeNull();
    view.unmount();
    mount(<AgentChat agent={{ ...signedOut, cliSignedIn: "yes" } as AgentSummary} index={0} />);
    expect(await screen.findByRole("button", { name: "Try again" })).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Sign in to Claude" })).toBeNull();
  });
});

describe("Claude sign-in requests", () => {
  it("call the control routes without a doubled /api prefix", async () => {
    vi.restoreAllMocks();
    const fetch = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith("/code") || url === "/api/claude-sign-in"
      ? view
      : url.endsWith("/claude-sign-in") ? { signInId, url: "https://claude.com/cai/oauth/authorize?state=x" } : {}), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await api.startClaudeSignIn(agent.id);
    await api.submitClaudeSignIn(signInId, code);
    await api.cancelClaudeSignIn(signInId);
    await api.claudeSignIn();
    await api.signOutClaude();
    expect(fetch.mock.calls.map(call => [call[1]?.method, call[0]])).toEqual([
      ["POST", `/api/agents/${agent.id}/claude-sign-in`],
      ["POST", `/api/claude-sign-in/${signInId}/code`],
      ["DELETE", `/api/claude-sign-in/${signInId}`],
      ["GET", "/api/claude-sign-in"],
      ["DELETE", "/api/claude-sign-in"],
    ]);
    vi.unstubAllGlobals();
  });
});
