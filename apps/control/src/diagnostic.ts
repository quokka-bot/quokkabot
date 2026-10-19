import { randomUUID } from "node:crypto";
import { sha256Hex } from "@quokkabot/shared/node";
import type { Logger } from "pino";
import { clientsFor, context } from "./app.js";
import { newSecret } from "./auth.js";
import { ComputerService } from "./computer.js";
import type { ControlConfig } from "./config.js";
import { maybeOne, one } from "./db.js";
import { PolicyService } from "./policy.js";

// Operator self-test without a model. `diagnostic start` opens a task with a run whose MCP token is printed, so a test
// script can act exactly where the CLI would (from the CLI network), plus a 15-minute owner session for the owner
// API. `diagnostic end <runId> <sessionToken>` closes the run, revokes the token and the session, and pauses the browser. Only
// someone with root on the host can run it, and every step is in the audit log.
export async function diagnostic(config: ControlConfig, log: Logger, args: string[]): Promise<void> {
  const { db, audit, slots } = await context(config);
  const { supervisor, egress, handles } = clientsFor(config);
  const policy = new PolicyService(db, egress, audit, log, () => slots.configuredIds, slots);
  const computer = new ComputerService(db, supervisor, egress, policy, audit, handles, log, slots);
  const firstId = (await slots.ids())[0];
  const agent = config.agents.find((item) => item.agentId === firstId);
  if (!agent) throw new Error("no agent added");
  try {
    if (args[0] === "start") {
      const allow = args.slice(1).filter((a) => a.startsWith("--allow=")).map((a) => a.slice("--allow=".length));
      const busy = await maybeOne(db, "select 1 from runs where agent_id = $1 and state in ('starting','running') limit 1", [agent.agentId]);
      if (busy) throw new Error("a run is active; wait for it or cancel it first");
      if (!(await computer.isRunning(agent.agentId).catch(() => false))) await computer.start(agent.agentId);
      // The lease first: if the browser is not reachable, nothing has been written yet.
      await computer.setLease(agent.agentId, "agent", "system");
      const sessionToken = newSecret();
      await db.query("insert into sessions (hash, expires_at, fresh_until) values ($1, now() + interval '15 minutes', now() + interval '15 minutes')", [sha256Hex(sessionToken)]);
      const taskId = randomUUID();
      const runId = randomUUID();
      const mcpToken = newSecret();
      const row = await one<{ model: string; effort: string }>(db, "select model, effort from agents where id = $1", [agent.agentId]);
      await db.query(
        `insert into tasks (id, agent_id, title, prompt, state, model, effort, session_id) values ($1, $2, 'Diagnostic run', 'operator self-test', 'running', $3, $4, $5)`,
        [taskId, agent.agentId, row.model, row.effort, randomUUID()],
      );
      await db.query(
        `insert into runs (id, task_id, agent_id, attempt, state, prompt, resume, mcp_token_hash, diagnostic) values ($1, $2, $3, 1, 'running', 'operator self-test', false, $4, true)`,
        [runId, taskId, agent.agentId, sha256Hex(mcpToken)],
      );
      for (const pattern of allow) {
        await db.query("insert into domain_rules (id, agent_id, pattern, attended, task_id, created_by) values (gen_random_uuid(), $1, $2, false, $3, 'operator')", [agent.agentId, pattern, taskId]);
      }
      await policy.push();
      await audit.append(agent.agentId, "system", "run.started", { taskId, runId, diagnostic: true, allow });
      process.stdout.write(`${JSON.stringify({ agentId: agent.agentId, taskId, runId, mcpToken, sessionToken, mcpUrl: agent.mcpUrl })}\n`);
    } else if (args[0] === "end" && args[1] && args[2]) {
      const runId = args[1];
      const sessionToken = args[2];
      const run = await maybeOne<{ task_id: string }>(db, "update runs set state = 'exited', exit_code = 0, token_revoked = true, finalized = true, ended_at = now() where id = $1 and diagnostic returning task_id", [runId]);
      if (!run) throw new Error("no such run");
      await db.query("update tasks set state = 'completed', result_summary = 'Diagnostic run', updated_at = now() where id = $1", [run.task_id]);
      await db.query("delete from domain_rules where task_id = $1", [run.task_id]);
      await db.query("update sessions set revoked_at = now() where hash = $1", [sha256Hex(sessionToken)]);
      await computer.setLease(agent.agentId, "paused", "system");
      await policy.push();
      await audit.append(agent.agentId, "system", "run.exited", { runId, diagnostic: true });
      process.stdout.write("diagnostic run closed\n");
    } else {
      throw new Error("usage: diagnostic start [--allow=<domain>...] | diagnostic end <runId> <sessionToken>");
    }
  } finally {
    await db.end();
  }
}
