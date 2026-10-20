import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeSignInCode } from "@quokkabot/shared";
import { buildServer, type HttpDeps } from "../src/http.js";
import { AgentSlots } from "../src/agents.js";
import { UpstreamError } from "../src/clients.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const signInId = "22222222-2222-4222-8222-222222222222";
const code = "distinctive_secret_code#distinctive_secret_state";
const view = { signedIn: true, signedInAt: "2026-10-20T10:00:00.000Z" };
const headers = { host: "quokkabot.test", origin: "https://quokkabot.test" };

describe("owner Claude sign-in routes", () => {
  let running: boolean;
  let ownerSession: boolean;
  let shared: { id: string; signed_in_at: Date } | null;
  let generation: number;
  let added: boolean;
  let slots: AgentSlots;
  let logs: string[];
  let audit: ReturnType<typeof vi.fn>;
  let submit: ReturnType<typeof vi.fn>;
  let startComputer: ReturnType<typeof vi.fn>;
  let startSignIn: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;
  let signOutClaude: ReturnType<typeof vi.fn>;
  let app: Awaited<ReturnType<typeof buildServer>>["app"];
  beforeEach(async () => {
    generation = 1; added = true;
    ownerSession = true; running = false; shared = null; logs = [];
    audit = vi.fn(); submit = vi.fn().mockResolvedValue(view); startComputer = vi.fn(); cancel = vi.fn(); signOutClaude = vi.fn().mockResolvedValue({ removed: true });
    startSignIn = vi.fn().mockResolvedValue({ signInId, url: "https://claude.com/cai/oauth/authorize?state=test" });
    const deps = {
      config: { agents: [{ agentId }], appOrigin: "https://quokkabot.test", appHost: "quokkabot.test", viewHost: "view.test", viewOrigin: "https://view.test" },
      auth: { session: async () => ownerSession ? { hash: "owner" } : null },
      db: { query: async (sql: string, values: unknown[]) => {
        if (sql.startsWith("select * from agents")) return { rows: added ? [{ id: agentId, generation, added_at: new Date(), removing_at: null }] : [] };
        if (sql.startsWith("select 1 from tasks")) return { rows: running ? [{}] : [] };
        if (sql.startsWith("select id from agents where id = any")) return { rows: added ? [{ id: agentId }] : [] };
        if (sql.startsWith("insert into claude_sign_in")) {
          const signedInAt = new Date(values[1] as string);
          if (!shared || shared.signed_in_at <= signedInAt) shared = { id: values[0] as string, signed_in_at: signedInAt };
          return { rows: [] };
        }
        if (sql.startsWith("select id, signed_in_at from claude_sign_in")) return { rows: shared ? [shared] : [] };
        if (sql.startsWith("delete from claude_sign_in")) { shared = null; return { rows: [] }; }
        throw new Error(`Unexpected SQL: ${sql}`);
      } },
      computer: { isRunning: async () => false, start: startComputer },
      supervisor: { startSignIn, submitSignIn: submit, cancelSignIn: cancel, signOutClaude }, audit: { append: audit },
      log: pino({}, { write: (text) => { logs.push(text); } }),
    } as unknown as HttpDeps;
    slots = new AgentSlots(deps.db, deps.config, deps.audit);
    deps.slots = slots;
    app = (await buildServer(deps)).app;
  });
  afterEach(async () => { await app.close(); });
  const startPath = `/api/agents/${agentId}/claude-sign-in`;
  const codePath = `/api/claude-sign-in/${signInId}/code`;
  async function start() {
    const result = await app.inject({ method: "POST", url: startPath, headers, payload: {} });
    expect(result.statusCode).toBe(200);
    return result;
  }

  it.each(["short#short", "a".repeat(8), "a".repeat(257) + "#abcdefgh", "abcdefgh#abcdefgh\n", "abcdefgh#abcdefgh#extra", "a+b/ccdd#abcdefgh"])("rejects invalid code shape %s", async (value) => {
    expect(ClaudeSignInCode.safeParse({ code: value }).success).toBe(false);
    await start();
    const response = await app.inject({ method: "POST", url: codePath, headers, payload: { code: value } });
    expect(response.statusCode).toBe(400);
    expect(submit).not.toHaveBeenCalled();
    expect(shared).toBeNull();
    expect(audit).not.toHaveBeenCalled();
    expect(logs.join("")).not.toContain(value);
  });

  it("starts the computer, submits once, records the sign-in all agents share, and audits it for every agent", async () => {
    await start();
    expect(startComputer).toHaveBeenCalledWith(agentId);
    const response = await app.inject({ method: "POST", url: codePath, headers, payload: { code } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(view);
    expect(submit).toHaveBeenCalledWith(signInId, code);
    expect(shared).toEqual({ id: signInId, signed_in_at: new Date(view.signedInAt) });
    expect(audit).toHaveBeenCalledWith(agentId, "owner", "claude.signed_in", { allAgents: true, from: agentId });
    expect(JSON.stringify(audit.mock.calls) + logs.join("")).not.toContain(code);
    const read = await app.inject({ method: "GET", url: "/api/claude-sign-in", headers });
    expect(read.json()).toEqual(view);
  });

  it("signs every agent out: removes the stored token whichever sign-in made it, then the record", async () => {
    shared = { id: signInId, signed_in_at: new Date(view.signedInAt) };
    const response = await app.inject({ method: "DELETE", url: "/api/claude-sign-in", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ signedIn: false, signedInAt: null });
    expect(signOutClaude).toHaveBeenCalledExactlyOnceWith();
    expect(shared).toBeNull();
    expect(audit).toHaveBeenCalledWith(agentId, "owner", "claude.signed_out", { allAgents: true });
  });

  it("signs out only after a sign-in that is finishing, so the record never outlives or misses the token", async () => {
    await start();
    let finish!: (value: typeof view) => void;
    submit.mockImplementationOnce(() => new Promise<typeof view>((resolve) => { finish = resolve; }));
    const signingIn = app.inject({ method: "POST", url: codePath, headers, payload: { code } }).then(result => result);
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    const signingOut = app.inject({ method: "DELETE", url: "/api/claude-sign-in", headers }).then(result => result);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signOutClaude).not.toHaveBeenCalled();
    finish(view);
    expect((await signingIn).statusCode).toBe(200);
    expect((await signingOut).json()).toEqual({ signedIn: false, signedInAt: null });
    expect(signOutClaude).toHaveBeenCalledOnce();
    expect(shared).toBeNull();
  });

  it("keeps the record when the supervisor cannot remove the token", async () => {
    shared = { id: signInId, signed_in_at: new Date(view.signedInAt) };
    signOutClaude.mockRejectedValue(new Error("supervisor down"));
    const response = await app.inject({ method: "DELETE", url: "/api/claude-sign-in", headers });
    expect(response.statusCode).toBe(502);
    expect(shared).not.toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a malformed supervisor reply instead of recording a sign-in", async () => {
    await start();
    submit.mockResolvedValue({ signedIn: false, signedInAt: null });
    const response = await app.inject({ method: "POST", url: codePath, headers, payload: { code } });
    expect(response.statusCode).toBe(502);
    expect(shared).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("keeps the agent signed out on failure and redacts echoed codes from errors and logs", async () => {
    await start();
    submit.mockRejectedValue(new UpstreamError(`contains ${code}`, 400, JSON.stringify({ message: `Login failed: rejected ${code}\u0007` })));
    const response = await app.inject({ method: "POST", url: codePath, headers, payload: { code } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("Login failed: rejected [redacted]");
    expect(shared).toBeNull();
    expect(audit).not.toHaveBeenCalled();
    expect(response.body + logs.join("")).not.toContain(code);
  });

  it("refuses while a task is running before starting its computer", async () => {
    running = true;
    const response = await app.inject({ method: "POST", url: startPath, headers, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe("Wait for the current task to finish");
    expect(startComputer).not.toHaveBeenCalled();
    expect(startSignIn).not.toHaveBeenCalled();
  });

  it("cancels an open sign-in and refuses a code after cancellation", async () => {
    await start();
    expect((await app.inject({ method: "DELETE", url: `/api/claude-sign-in/${signInId}`, headers })).statusCode).toBe(200);
    expect(cancel).toHaveBeenCalledWith(signInId);
    expect((await app.inject({ method: "POST", url: codePath, headers, payload: { code } })).statusCode).toBe(404);
  });

  it.each(["submit", "cancel"])("fences a %s queued behind removal and slot reuse", async (action) => {
    await start();
    const release = await slots.acquire(agentId);
    const acquire = vi.spyOn(slots, "acquire");
    const pending = app.inject({ method: action === "submit" ? "POST" : "DELETE", url: action === "submit" ? codePath : `/api/claude-sign-in/${signInId}`, headers,
      ...(action === "submit" ? { payload: { code } } : {}) }).then(result => result);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledWith(agentId));
    added = false;
    generation += 1;
    added = true;
    release();
    expect((await pending).statusCode).toBe(409);
    expect(submit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(shared).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  // The token is stored once the supervisor answers; it belongs to every agent, not to the slot that ran the sign-in.
  it.each(["replaced", "free"])("records a sign-in Claude finished while the slot became %s", async kind => {
    await start();
    let finish!: (value: typeof view) => void;
    submit.mockImplementationOnce(() => new Promise<typeof view>((resolve) => { finish = resolve; }));
    const pending = app.inject({ method: "POST", url: codePath, headers, payload: { code } }).then(result => result);
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    if (kind === "replaced") generation += 1;
    else added = false;
    finish(view);
    expect((await pending).statusCode).toBe(200);
    expect(shared).toEqual({ id: signInId, signed_in_at: new Date(view.signedInAt) });
    expect(audit.mock.calls.length).toBe(kind === "free" ? 0 : 1);
  });

  it("holds the slot lock until a supervisor submission finishes", async () => {
    await start();
    let finish!: (value: typeof view) => void;
    submit.mockImplementationOnce(() => new Promise<typeof view>((resolve) => { finish = resolve; }));
    const pending = app.inject({ method: "POST", url: codePath, headers, payload: { code } }).then(result => result);
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    let entered = false;
    const next = slots.exclusive(agentId, async () => { entered = true; });
    await Promise.resolve();
    expect(entered).toBe(false);
    finish(view);
    expect((await pending).statusCode).toBe(200);
    await next;
    expect(entered).toBe(true);
  });

  it("does not log a code even when the upstream transport throws an error containing it", async () => {
    await start();
    submit.mockRejectedValue(new Error(code));
    const response = await app.inject({ method: "POST", url: codePath, headers, payload: { code } });
    expect(response.statusCode).toBe(502);
    expect(logs.join("") + response.body).not.toContain(code);
  });

  it("requires owner authentication and the app origin", async () => {
    expect((await app.inject({ method: "POST", url: startPath, headers: { host: headers.host }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/api/claude-sign-in", headers: { host: headers.host } })).statusCode).toBe(403);
    ownerSession = false;
    expect((await app.inject({ method: "POST", url: startPath, headers, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/claude-sign-in", headers })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/api/claude-sign-in", headers })).statusCode).toBe(401);
    expect(startSignIn).not.toHaveBeenCalled();
    expect(signOutClaude).not.toHaveBeenCalled();
  });
});
