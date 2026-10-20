import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db.js";
import { TaskService } from "../src/tasks.js";

// A withdrawal that fences a run after finalizeRun read it: the run still ends as cancelled and the task stops
// with the consent error, never as a normal result.
describe("finalizing a run fenced for a withdrawn permission", () => {
  it("reads the fence again in the final update", async () => {
    const runId = "run-1";
    const taskId = "task-1";
    const agentId = "agent-1";
    const finishes: unknown[][] = [];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith("select * from runs where id")) return { rows: [{ id: runId, task_id: taskId, agent_id: agentId, state: "running", fence_reason: null, finalized: false, final_result: null }] };
      if (sql.startsWith("update runs set state = case when fence_reason = 'ai_consent'")) {
        expect(values[1]).toBe("exited");
        return { rows: [{ id: runId, task_id: taskId, agent_id: agentId, state: "cancelled", fence_reason: "ai_consent", attempt: 1, exit_code: 0, started_at: new Date(), ended_at: new Date(), last_event_at: null }] };
      }
      if (sql.startsWith("select * from tasks where id")) return { rows: [{ id: taskId, agent_id: agentId, state: "running", pending_prompt: null }] };
      if (sql.startsWith("select (select coalesce(sum(uncertain_mutations)")) return { rows: [{ n: 0 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const db = { query } as unknown as Db;
    const audit = { append: vi.fn() };
    const computer = { lease: async () => ({ holder: "paused" }) };
    const service = new TaskService(db, { append: vi.fn() } as never, audit as never, {} as never, computer as never, {} as never,
      pino({ level: "silent" }), () => [agentId], {} as never);
    Object.defineProperty(service, "finishTask", { value: async (...args: unknown[]) => { finishes.push(args); } });
    await (service as unknown as { finalizeRun(...args: unknown[]): Promise<void> }).finalizeRun(runId, 0, { kind: "success", text: "Done." }, "", "exited");
    expect(audit.append).toHaveBeenCalledWith(agentId, "system", "run.exited", { runId, state: "cancelled", exitCode: 0 });
    expect(finishes).toEqual([[expect.objectContaining({ id: taskId }), "cancelled", null, "Stopped: sending to Anthropic is off for this agent."]]);
  });
});
