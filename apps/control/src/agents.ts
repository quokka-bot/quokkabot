import { AgentName } from "@quokkabot/shared";
import type { AuditLog } from "./audit.js";
import { UpstreamError, type SupervisorClient } from "./clients.js";
import type { ComputerService } from "./computer.js";
import type { ControlConfig } from "./config.js";
import type { Connectors } from "./connectors.js";
import { type Db, many, maybeOne, withTx } from "./db.js";
import { HttpError } from "./errors.js";
import { DEFAULT_BROWSER_RULES, type PolicyService } from "./policy.js";
import type { TaskService } from "./tasks.js";

export function capacityMessage(total: number): string {
  return `This server has room for ${total} agents. Set QUOKKABOT_AGENTS higher on the server and run install.sh again to add more.`;
}

export interface SlotRow {
  id: string;
  idx: number;
  generation: number;
  added_at: Date | null;
  removing_at: Date | null;
  killed_at: Date | null;
}

interface RemovalDeps {
  tasks: TaskService;
  computer: ComputerService;
  supervisor: SupervisorClient;
  connectors: Connectors;
  policy: PolicyService;
  drainTools: (agentId: string) => Promise<void>;
  closeRelays: () => void;
  dropSignIns: (agentId: string) => void;
}

export class AgentSlots {
  readonly configuredIds: string[];
  // The emergency kill path keeps working during a database outage, using the last confirmed added set.
  readonly knownIds = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();
  private revision = 0;

  constructor(private readonly db: Db, readonly config: ControlConfig, private readonly audit: AuditLog) {
    this.configuredIds = config.agents.map((agent) => agent.agentId);
  }

  async initialize(): Promise<void> {
    for (const agent of this.config.agents) {
      await this.db.query(
        `insert into agents (id, idx, name, model, effort, added_at)
         values ($1, $2, $3, $4, $5, case when $2 = 1 then now() else null end) on conflict (id) do nothing`,
        [agent.agentId, agent.index, `Agent ${agent.index}`, this.config.defaultModel, this.config.defaultEffort],
      );
    }
    await this.ids();
  }

  async ids(): Promise<string[]> {
    const revision = this.revision;
    const rows = await many<{ id: string }>(this.db,
      "select id from agents where id = any($1::uuid[]) and added_at is not null order by idx", [this.configuredIds]);
    if (revision === this.revision) {
      this.knownIds.clear();
      for (const row of rows) this.knownIds.add(row.id);
    }
    return rows.map((row) => row.id);
  }

  async require(id: string, allowRemoving = true, generation?: string | number): Promise<SlotRow> {
    if (!this.configuredIds.includes(id)) throw new HttpError(404, "unknown_agent", "No such agent.");
    const row = await maybeOne<SlotRow>(this.db, "select * from agents where id = $1 and added_at is not null", [id]);
    if (generation !== undefined && (!row || String(row.generation) !== String(generation))) {
      throw new HttpError(409, "agent_replaced", "This agent was removed. Reload to see the current agents.");
    }
    if (!row) throw new HttpError(404, "unknown_agent", "No such agent.");
    if (!allowRemoving && row.removing_at) throw new HttpError(409, "agent_removing", "Removal is in progress. Retry Remove agent to finish.");
    return row;
  }

  async acquire(id: string): Promise<() => void> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(id, current);
    await previous;
    return () => { release(); if (this.locks.get(id) === current) this.locks.delete(id); };
  }

  async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(id);
    try { return await action(); } finally { release(); }
  }

  async create(name: string): Promise<string> {
    name = AgentName.parse(name);
    const id = await withTx(this.db, async (tx) => {
      const slot = await maybeOne<{ id: string }>(tx,
        `select id from agents where id = any($1::uuid[]) and added_at is null order by idx limit 1 for update skip locked`,
        [this.configuredIds]);
      if (!slot) throw new HttpError(409, "no_free_slot", capacityMessage(this.configuredIds.length));
      await tx.query(
        "update agents set name = $2, added_at = $5::timestamptz, generation = generation + 1, model = $3, effort = $4, cli_signed_in = 'no', cli_account = null, cli_plan = null, look_shape = null, look_colour = null, removing_at = null where id = $1",
        [slot.id, name, this.config.defaultModel, this.config.defaultEffort, new Date().toISOString()]);
      await this.audit.append(slot.id, "owner", "agent.added", { name }, tx);
      return slot.id;
    });
    this.revision += 1;
    this.knownIds.add(id);
    return id;
  }

  async remove(id: string, deps: RemovalDeps, generation?: string): Promise<void> {
    return this.exclusive(id, () => this.removeNow(id, deps, generation));
  }

  // Owner mutations and dispatch use the same lock. The persistent fence survives a crash.
  private async removeNow(id: string, deps: RemovalDeps, generation?: string): Promise<void> {
    const row = await this.require(id, true, generation);
    if (row.killed_at || (await deps.supervisor.computer(id)).killed) throw new HttpError(409, "killed", "Release the kill switch first");
    await this.db.query("update agents set removing_at = coalesce(removing_at, now()) where id = $1", [id]);
    deps.dropSignIns(id);
    deps.closeRelays();
    await deps.tasks.cancelAgent(id);
    await deps.computer.stop(id);
    await deps.drainTools(id);
    // Confirm every revoke before deleting any local account or chat data. A failed revoke can be retried.
    await deps.connectors.removeAgent(id);
    deps.policy.forgetAgent(id);
    await withTx(this.db, async (tx) => {
      for (const table of ["ai_consents", "connect_states", "connectors", "logins", "domain_requests", "domain_rules", "blocked_hosts", "files", "browser_commands", "view_tickets", "view_sessions", "attachments"]) {
        await tx.query(`delete from ${table} where agent_id = $1`, [id]);
      }
      await tx.query("delete from tasks where agent_id = $1", [id]);
      await tx.query("delete from kv where key = $1", [`attended_clear_pending:${id}`]);
      for (const pattern of DEFAULT_BROWSER_RULES) {
        await tx.query("insert into domain_rules (id, agent_id, pattern, attended, created_by) values (gen_random_uuid(), $1, $2, false, 'system')", [id, pattern]);
      }
    });
    await deps.policy.push();
    // Keep added_at until the supervisor confirms the wipe. An interrupted removal remains visible and retryable.
    await deps.supervisor.wipe(id).catch((error: unknown) => {
      if (error instanceof UpstreamError && error.status === 409) throw new HttpError(409, "agent_busy", "The computer is still stopping. Retry Remove agent.");
      throw error;
    });
    await withTx(this.db, async (tx) => {
      const current = await maybeOne<SlotRow>(tx, "select * from agents where id = $1 for update", [id]);
      if (current?.killed_at) throw new HttpError(409, "killed", "Release the kill switch first");
      await this.audit.append(id, "owner", "agent.removed", {}, tx);
      await tx.query(
        `update agents set added_at = null, removing_at = null, name = $2, model = $3, effort = $4, cli_signed_in = 'no', cli_account = null, cli_plan = null,
         lease_holder = 'paused', lease_generation = lease_generation + 1, lease_expires_at = null,
         attended_open = false, selkies_owner_token = null where id = $1`,
        [id, `Agent ${row.idx}`, this.config.defaultModel, this.config.defaultEffort]);
    });
    this.revision += 1;
    this.knownIds.delete(id);
  }
}
