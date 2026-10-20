import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { TaskService } from "../src/tasks.js";

const runId = "run-1";
const taskId = "task-1";
const agentId = "agent-1";
const otherAgentId = "agent-2";
const signInId = "33333333-3333-4333-8333-333333333333";
const runStarted = new Date("2026-10-20T10:00:00Z");
const signedOutText = "Claude Code is signed out. Sign in to Claude, then try again.";

// A run that Claude refused: the sign-in it ran with is the one that goes. A shared sign-in stored before the run
// started was that sign-in; otherwise it was the agent's own.
function fixture(shared: { id: string; signed_in_at: Date } | null) {
  const state = { shared, agentSignedIn: "yes" };
  const finishes: unknown[][] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("select * from runs where id")) return { rows: [{ id: runId, task_id: taskId, agent_id: agentId, state: "running", fence_reason: null, finalized: false, final_result: null }] };
    if (sql.startsWith("update runs set state")) return { rows: [{ id: runId, task_id: taskId, agent_id: agentId, state: "exited", fence_reason: null, attempt: 1, exit_code: 1, started_at: runStarted, ended_at: new Date(), last_event_at: null }] };
    if (sql.startsWith("select * from tasks where id")) return { rows: [{ id: taskId, agent_id: agentId, state: "running", pending_prompt: null }] };
    if (sql.startsWith("delete from claude_sign_in where signed_in_at <= $1 returning id")) {
      const removed = state.shared && state.shared.signed_in_at <= (values[0] as Date) ? state.shared : null;
      if (removed) state.shared = null;
      return { rows: removed ? [{ id: removed.id }] : [] };
    }
    if (sql.startsWith("select 1 from claude_sign_in where signed_in_at <= $1")) return { rows: state.shared && state.shared.signed_in_at <= (values[0] as Date) ? [{}] : [] };
    if (sql.startsWith("update agents set cli_signed_in = 'no'")) { expect(values).toEqual([agentId]); state.agentSignedIn = "no"; return { rows: [] }; }
    if (sql.startsWith("update agents set cli_signed_in = 'yes'")) { state.agentSignedIn = "yes"; return { rows: [] }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const audit = { append: vi.fn() };
  const supervisor = { signOutClaude: vi.fn(async () => ({ removed: true })) };
  const service = new TaskService({ query } as unknown as Db, { append: vi.fn() } as never, audit as never, supervisor as never,
    { lease: async () => ({ holder: "paused" }) } as never, {} as never, pino({ level: "silent" }), () => [agentId, otherAgentId], {} as never);
  Object.defineProperty(service, "finishTask", { value: async (...args: unknown[]) => { finishes.push(args); } });
  const finalize = () => (service as unknown as { finalizeRun(...args: unknown[]): Promise<void> })
    .finalizeRun(runId, 1, { isError: true, subtype: "success", text: "Invalid API key · Please run /login", sessionId: null }, "", "exited");
  const usedShared = () => (service as unknown as { usedSharedSignIn(startedAt: Date): Promise<boolean> }).usedSharedSignIn(runStarted);
  return { state, finishes, audit, supervisor, finalize, usedShared };
}

describe("a run Claude signed out", () => {
  it("removes a shared sign-in stored before the run, for every agent, and leaves the agent's own sign-in alone", async () => {
    const { state, finishes, audit, supervisor, finalize } = fixture({ id: signInId, signed_in_at: new Date(runStarted.getTime() - 1000) });
    await finalize();
    expect(state.shared).toBeNull();
    expect(supervisor.signOutClaude).toHaveBeenCalledExactlyOnceWith(signInId);
    expect(state.agentSignedIn).toBe("yes");
    for (const id of [agentId, otherAgentId]) expect(audit.append).toHaveBeenCalledWith(id, "system", "claude.signed_out", { allAgents: true, reason: "refused_by_claude" });
    expect(finishes).toEqual([[expect.objectContaining({ id: taskId }), "failed", null, signedOutText]]);
  });

  it("keeps a shared sign-in made after the run started and marks the agent's own sign-in signed out", async () => {
    const newer = { id: signInId, signed_in_at: new Date(runStarted.getTime() + 1000) };
    const { state, finishes, supervisor, finalize } = fixture(newer);
    await finalize();
    expect(state.shared).toEqual(newer);
    expect(supervisor.signOutClaude).not.toHaveBeenCalled();
    expect(state.agentSignedIn).toBe("no");
    expect(finishes).toEqual([[expect.objectContaining({ id: taskId }), "failed", null, signedOutText]]);
  });

  it("marks the agent's own sign-in signed out when no shared sign-in exists", async () => {
    const { state, supervisor, finalize } = fixture(null);
    await finalize();
    expect(supervisor.signOutClaude).not.toHaveBeenCalled();
    expect(state.agentSignedIn).toBe("no");
  });

  it("still fails the task when the supervisor cannot remove the refused token", async () => {
    const { state, finishes, supervisor, finalize } = fixture({ id: signInId, signed_in_at: new Date(runStarted.getTime() - 1000) });
    supervisor.signOutClaude.mockRejectedValueOnce(new Error("supervisor down"));
    await finalize();
    expect(state.shared).toBeNull();
    expect(finishes).toEqual([[expect.objectContaining({ id: taskId }), "failed", null, signedOutText]]);
  });

  it("counts a run as using the shared sign-in only when it was stored before the run started", async () => {
    expect(await fixture({ id: signInId, signed_in_at: new Date(runStarted.getTime() - 1000) }).usedShared()).toBe(true);
    expect(await fixture({ id: signInId, signed_in_at: new Date(runStarted.getTime() + 1000) }).usedShared()).toBe(false);
    expect(await fixture(null).usedShared()).toBe(false);
  });
});
