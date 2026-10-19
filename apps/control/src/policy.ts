import {
  type AgentEgressPolicy,
  CLAUDE_CODE_EGRESS,
  type EgressDecisionEvent,
  type EgressPolicySnapshot,
} from "@quokkabot/shared";
import type { Logger } from "pino";
import type { AuditLog } from "./audit.js";
import type { EgressClient } from "./clients.js";
import type { AgentSlots } from "./agents.js";
import { type Db, many, maybeOne } from "./db.js";

// A search engine the agent can use from its first task (owner-visible, removable like any rule).
export const DEFAULT_BROWSER_RULES = ["duckduckgo.com", "*.duckduckgo.com"];

// Keeps the egress proxy's policy equal to the database and records what it refused.
export class PolicyService {
  private pushing: Promise<void> = Promise.resolve();
  private readonly recent: EgressDecisionEvent[] = [];
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly egress: EgressClient,
    private readonly audit: AuditLog,
    private readonly log: Logger,
    private readonly agentIds: () => string[],
    private readonly slots?: AgentSlots,
  ) {}

  async snapshot(): Promise<EgressPolicySnapshot> {
    const agents: Record<string, AgentEgressPolicy> = {};
    for (const agentId of this.agentIds()) {
      const agent = await maybeOne<{ killed_at: Date | null; attended_open: boolean }>(
        this.db,
        "select killed_at, attended_open from agents where id = $1",
        [agentId],
      );
      if (!agent) continue;
      // Task-scoped grants belong to the task whose run is active; with no run, to the task waiting for the owner's
      // takeover (the owner needs its sites to log in). Never simply the newest running task: waiting tasks are running.
      const current =
        (await maybeOne<{ id: string }>(
          this.db,
          "select task_id as id from runs where agent_id = $1 and state in ('starting','running') order by started_at desc limit 1",
          [agentId],
        )) ??
        (await maybeOne<{ id: string }>(
          this.db,
          "select id from tasks where agent_id = $1 and state = 'running' and blocked_reason = 'takeover' order by updated_at desc limit 1",
          [agentId],
        ));
      const rules = await many<{ pattern: string; attended: boolean; task_id: string | null; expires_at: Date | null }>(
        this.db,
        "select pattern, attended, task_id, expires_at from domain_rules where agent_id = $1 and (expires_at is null or expires_at > now())",
        [agentId],
      );
      agents[agentId] = {
        frozen: agent.killed_at !== null,
        cli: { allow: [...CLAUDE_CODE_EGRESS] },
        browser: {
          rules: rules.map((r) => ({
            pattern: r.pattern,
            attended: r.attended,
            taskId: r.task_id as never,
            expiresAt: r.expires_at?.toISOString() ?? null,
          })),
          attendedOpen: agent.attended_open,
          currentTaskId: (current?.id ?? null) as never,
        },
      };
    }
    const revision = await this.nextRevision();
    return { revision, agents };
  }

  private async nextRevision(): Promise<number> {
    const row = await maybeOne<{ value: number }>(
      this.db,
      `insert into kv (key, value) values ('egress_revision', '1'::jsonb)
       on conflict (key) do update set value = to_jsonb((kv.value)::int + 1) returning (value)::int as value`,
    );
    if (!row) throw new Error("egress revision not stored");
    return row.value;
  }

  // Serialised: a later push always carries a higher revision than an earlier one.
  push(): Promise<void> {
    this.pushing = this.pushing
      .catch(() => undefined)
      .then(async () => {
        const snapshot = await this.snapshot();
        await this.egress.putPolicy(snapshot);
      });
    return this.pushing;
  }

  // Decisions from the proxy: blocked hosts go to the owner's Domains view.
  async runDecisionLoop(): Promise<void> {
    let after = 0;
    let epoch: string | null = null;
    while (!this.stopped) {
      try {
        const response = await this.egress.decisions(after, 20);
        if (response.epoch !== epoch) {
          // The proxy restarted and numbers its events from 1 again.
          if (epoch !== null && after !== 0) {
            epoch = response.epoch;
            after = 0;
            continue;
          }
          epoch = response.epoch;
        }
        for (const event of response.events) {
          after = Math.max(after, event.seq);
          if (this.slots) await this.slots.exclusive(event.agentId, () => this.recordDecision(event));
          else await this.recordDecision(event);
        }
      } catch (error) {
        this.log.warn({ err: String(error) }, "egress decisions poll failed");
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  private async recordDecision(event: EgressDecisionEvent): Promise<void> {
    if (this.slots) {
      if (!this.slots.knownIds.has(event.agentId)) return;
      const slot = await this.slots.require(event.agentId);
      if (slot.removing_at || !slot.added_at || Date.parse(event.at) <= slot.added_at.getTime()) return;
    }
    this.recent.push(event);
    if (this.recent.length > 5000) this.recent.shift();
    if (event.decision === "allowed") return;
    const task = await maybeOne<{ id: string }>(
      this.db,
      "select task_id as id from runs where agent_id = $1 and state in ('starting','running') order by started_at desc limit 1",
      [event.agentId],
    );
    await this.db.query(
      `insert into blocked_hosts (agent_id, host, decision, count, last_at, task_id) values ($1, $2, $3, 1, $4, $5)
       on conflict (agent_id, host, decision) do update set count = blocked_hosts.count + 1, last_at = excluded.last_at, task_id = excluded.task_id`,
      [event.agentId, event.host, event.decision, event.at, task?.id ?? null],
    );
  }

  forgetAgent(agentId: string): void {
    for (let index = this.recent.length - 1; index >= 0; index -= 1) {
      if (this.recent[index]?.agentId === agentId) this.recent.splice(index, 1);
    }
  }

  // Hosts the browser was refused since a moment, for one agent: attached to browser tool results.
  blockedSince(agentId: string, since: number): string[] {
    const hosts = new Set<string>();
    for (const event of this.recent) {
      if (event.agentId !== agentId || event.listener !== "browser" || event.decision === "allowed") continue;
      if (Date.parse(event.at) >= since - 500) hosts.add(event.host);
    }
    return [...hosts];
  }

  async ensureDefaultRules(agentId: string): Promise<void> {
    const seeded = await maybeOne(this.db, "select 1 from kv where key = $1", [`default_rules:${agentId}`]);
    if (seeded) return;
    for (const pattern of DEFAULT_BROWSER_RULES) {
      await this.db.query(
        "insert into domain_rules (id, agent_id, pattern, attended, created_by) values (gen_random_uuid(), $1, $2, false, 'system')",
        [agentId, pattern],
      );
      await this.audit.append(agentId, "system", "domain.rule_added", { pattern, attended: false, scope: "permanent" });
    }
    await this.db.query("insert into kv (key, value) values ($1, 'true'::jsonb)", [`default_rules:${agentId}`]);
  }

  stop(): void {
    this.stopped = true;
  }
}
