import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeSignInCode } from "@quokkabot/shared";
import { buildServer, type HttpDeps } from "../src/http.js";
import { AgentSlots } from "../src/agents.js";
import { UpstreamError } from "../src/clients.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const signInId = "22222222-2222-4222-8222-222222222222";
const code = "distinctive_secret_code#distinctive_secret_state";
const status = { loggedIn: true, email: "owner@example.test", subscriptionType: "max" };
const headers = { host: "quokkabot.test", origin: "https://quokkabot.test" };

describe("owner Claude sign-in routes", () => {
  let running: boolean;
  let ownerSession: boolean;
  let signedIn: boolean;
  let account: string | null;
  let plan: string | null;
  let generation: number;
  let added: boolean;
  let slots: AgentSlots;
  let logs: string[];
  let audit: ReturnType<typeof vi.fn>;
  let submit: ReturnType<typeof vi.fn>;
  let startComputer: ReturnType<typeof vi.fn>;
  let startSignIn: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;
  let app: Awaited<ReturnType<typeof buildServer>>["app"];
  beforeEach(async () => {
    generation = 1; added = true;
    ownerSession = true; running = false; signedIn = false; account = null; plan = null; logs = [];
    audit = vi.fn(); submit = vi.fn().mockResolvedValue(status); startComputer = vi.fn(); cancel = vi.fn();
    startSignIn = vi.fn().mockResolvedValue({ signInId, url: "https://claude.com/cai/oauth/authorize?state=test" });
    const deps = {
      config: { agents: [{ agentId }], appOrigin: "https://quokkabot.test", appHost: "quokkabot.test", viewHost: "view.test", viewOrigin: "https://view.test" },
      auth: { session: async () => ownerSession ? { hash: "owner" } : null },
      db: { query: async (sql: string, values: unknown[]) => {
        if (sql.startsWith("select * from agents")) return { rows: added ? [{ id: agentId, generation, added_at: new Date(), removing_at: null }] : [] };
        if (sql.startsWith("select 1 from tasks")) return { rows: running ? [{}] : [] };
        if (sql.startsWith("update agents set cli_signed_in")) {
          if (!added || values[3] !== generation) return { rows: [] };
          signedIn = true; account = values[1] as string; plan = values[2] as string; return { rows: [{ id: agentId }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      } },
      computer: { isRunning: async () => false, start: startComputer },
      supervisor: { startSignIn, submitSignIn: submit, cancelSignIn: cancel }, audit: { append: audit },
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
    expect(signedIn).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    expect(logs.join("")).not.toContain(value);
  });

  it("starts the computer, submits once, stores account and plan, and audits only the email", async () => {
    await start();
    expect(startComputer).toHaveBeenCalledWith(agentId);
    const response = await app.inject({ method: "POST", url: codePath, headers, payload: { code } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(submit).toHaveBeenCalledWith(signInId, code);
    expect({ signedIn, account, plan }).toEqual({ signedIn: true, account: status.email, plan: "max" });
    expect(audit).toHaveBeenCalledWith(agentId, "owner", "claude.signed_in", { email: status.email });
    expect(JSON.stringify(audit.mock.calls) + logs.join("")).not.toContain(code);
  });

  it("keeps the agent signed out on failure and redacts echoed codes from errors and logs", async () => {
    await start();
    submit.mockRejectedValue(new UpstreamError(`contains ${code}`, 400, JSON.stringify({ message: `Login failed: rejected ${code}\u0007` })));
    const response = await app.inject({ method: "POST", url: codePath, headers, payload: { code } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("Login failed: rejected [redacted]");
    expect(signedIn).toBe(false);
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
    expect(signedIn).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each(["replaced", "free"])("refuses a delayed completion when the slot becomes %s and appends no audit", async kind => {
    await start();
    let finish!: (value: typeof status) => void;
    submit.mockImplementationOnce(() => new Promise<typeof status>((resolve) => { finish = resolve; }));
    const pending = app.inject({ method: "POST", url: codePath, headers, payload: { code } }).then(result => result);
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    // Simulate a changed database row as well as the in-process lock fence.
    if (kind === "replaced") generation += 1;
    else added = false;
    finish(status);
    expect((await pending).statusCode).toBe(409);
    expect(signedIn).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it("holds the slot lock until a supervisor submission finishes", async () => {
    await start();
    let finish!: (value: typeof status) => void;
    submit.mockImplementationOnce(() => new Promise<typeof status>((resolve) => { finish = resolve; }));
    const pending = app.inject({ method: "POST", url: codePath, headers, payload: { code } }).then(result => result);
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    let entered = false;
    const next = slots.exclusive(agentId, async () => { entered = true; });
    await Promise.resolve();
    expect(entered).toBe(false);
    finish(status);
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
    ownerSession = false;
    expect((await app.inject({ method: "POST", url: startPath, headers, payload: {} })).statusCode).toBe(401);
    expect(startSignIn).not.toHaveBeenCalled();
  });
});
