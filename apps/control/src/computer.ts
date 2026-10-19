import type { ComputerView, ControlLease } from "@quokkabot/shared";
import type { Logger } from "pino";
import type { AuditLog } from "./audit.js";
import { newSecret } from "./auth.js";
import type { BrowserServiceClient, EgressClient, SelkiesClient, SupervisorClient } from "./clients.js";
import { type Db, many, maybeOne, one } from "./db.js";
import { HttpError } from "./errors.js";
import type { PolicyService } from "./policy.js";
import type { AgentSlots } from "./agents.js";

export const OWNER_LEASE_MINUTES = 15;

export interface AgentHandles {
  browser: BrowserServiceClient;
  selkies: SelkiesClient;
}

interface AgentRow {
  id: string;
  killed_at: Date | null;
  lease_holder: "agent" | "owner" | "paused";
  lease_generation: number;
  lease_expires_at: Date | null;
  attended_open: boolean;
  selkies_owner_token: string | null;
}

// The agent's computer: lifecycle through the supervisor, who drives the browser (the control lease), the attended
// session and the kill switch.
export class ComputerService {
  private readonly starting = new Set<string>();
  private readonly leaseChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly supervisor: SupervisorClient,
    private readonly egress: EgressClient,
    private readonly policy: PolicyService,
    private readonly audit: AuditLog,
    private readonly handles: (agentId: string) => AgentHandles,
    private readonly log: Logger,
    private readonly slots?: AgentSlots,
  ) {}

  private async agent(agentId: string): Promise<AgentRow> {
    if (this.slots) await this.slots.require(agentId);
    const row = await maybeOne<AgentRow>(this.db, "select * from agents where id = $1 and added_at is not null", [agentId]);
    if (!row) throw new HttpError(404, "unknown_agent", "No such agent.");
    return row;
  }

  leaseOf(row: AgentRow): ControlLease {
    return {
      holder: row.lease_holder,
      generation: row.lease_generation,
      expiresAt: row.lease_expires_at?.toISOString() ?? null,
    };
  }

  async lease(agentId: string): Promise<ControlLease> {
    return this.leaseOf(await this.agent(agentId));
  }

  async view(agentId: string): Promise<ComputerView> {
    const row = await this.agent(agentId);
    let sandboxes: ComputerView["sandboxes"] = [];
    let state: ComputerView["state"] = "stopped";
    try {
      const status = await this.supervisor.computer(agentId);
      sandboxes = status.sandboxes;
      const running = status.sandboxes.filter((s) => s.state === "running").length;
      if (status.killed) state = "killed";
      else if (this.starting.has(agentId)) state = "starting";
      else if (running === status.sandboxes.length && running > 0) state = "running";
      else if (running > 0) state = "degraded";
    } catch (error) {
      this.log.warn({ err: String(error) }, "supervisor status failed");
      state = row.killed_at ? "killed" : "degraded";
    }
    return {
      state,
      sandboxes,
      lease: this.leaseOf(row),
      attendedOpen: row.attended_open,
      killedAt: row.killed_at?.toISOString() ?? null,
    };
  }

  async isRunning(agentId: string): Promise<boolean> {
    if (this.slots) await this.slots.require(agentId);
    const status = await this.supervisor.computer(agentId);
    return !status.killed && status.sandboxes.length > 0 && status.sandboxes.every((s) => s.state === "running");
  }

  async start(agentId: string): Promise<void> {
    if (this.slots) await this.slots.require(agentId, false);
    const row = await this.agent(agentId);
    if (row.killed_at) throw new HttpError(409, "killed", "The kill switch is on. Release it first.");
    if (this.starting.has(agentId)) return;
    this.starting.add(agentId);
    try {
      await this.supervisor.start(agentId);
      await this.waitForBrowser(agentId);
      await this.setLease(agentId, "paused", "system");
      await this.policy.push();
      await this.audit.append(agentId, "owner", "computer.started", {});
    } finally {
      this.starting.delete(agentId);
    }
  }

  private async waitForBrowser(agentId: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        await this.handles(agentId).browser.health();
        if (!(await this.handles(agentId).selkies.ready())) throw new Error("live view not serving yet");
        return;
      } catch (error) {
        lastError = String(error);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw new HttpError(504, "browser_not_ready", `The browser did not come up in 2 minutes: ${lastError.slice(0, 200)}`);
  }

  async stop(agentId: string): Promise<void> {
    await this.agent(agentId);
    const active = await maybeOne(this.db, "select 1 from runs where agent_id = $1 and state in ('starting','running') limit 1", [agentId]);
    if (active) throw new HttpError(409, "task_running", "A task is running. Cancel it first.");
    try {
      await this.handles(agentId).browser.shutdown();
    } catch (error) {
      this.log.warn({ err: String(error) }, "graceful browser shutdown failed; stopping anyway");
    }
    await this.supervisor.stop(agentId);
    await this.audit.append(agentId, "owner", "computer.stopped", {});
  }

  // Changes who drives the browser. The two services are told first, in the order that never lets the agent and the
  // owner drive at the same time; the database records the new lease only after both acknowledged it. A failed
  // revocation therefore leaves the stored lease as it was (an owner lease keeps its expiry), and the expiry sweep
  // retries it. Changes for one agent are serialised.
  setLease(agentId: string, holder: ControlLease["holder"], actor: "owner" | "agent" | "system"): Promise<ControlLease> {
    const previous = this.leaseChains.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.setLeaseNow(agentId, holder, actor));
    this.leaseChains.set(agentId, next);
    return next;
  }

  private async setLeaseNow(agentId: string, holder: ControlLease["holder"], actor: "owner" | "agent" | "system"): Promise<ControlLease> {
    const before = await this.agent(agentId);
    // The owner's live-view token: created once, kept in the database, never sent to the owner's browser.
    let ownerToken = before.selkies_owner_token;
    if (!ownerToken) {
      ownerToken = newSecret();
      await this.db.query("update agents set selkies_owner_token = $2 where id = $1", [agentId, ownerToken]);
    }
    const lease: ControlLease = {
      holder,
      generation: before.lease_generation + 1,
      expiresAt: holder === "owner" ? new Date(Date.now() + OWNER_LEASE_MINUTES * 60_000).toISOString() : null,
    };
    const { browser, selkies } = this.handles(agentId);
    if (holder === "owner") {
      await browser.setLease(lease);
      await selkies.setTokens(ownerToken, true);
    } else {
      await selkies.setTokens(ownerToken, false);
      await browser.setLease(lease);
    }
    await this.db.query(
      "update agents set lease_holder = $2, lease_generation = $3, lease_expires_at = $4 where id = $1",
      [agentId, lease.holder, lease.generation, lease.expiresAt],
    );
    if (holder === "owner") await this.audit.append(agentId, actor, "takeover.started", { generation: lease.generation });
    else if (before.lease_holder === "owner") await this.audit.append(agentId, actor, "takeover.ended", { holder, generation: lease.generation });
    return lease;
  }

  async takeover(agentId: string, action: "take" | "return"): Promise<ControlLease> {
    const row = await this.agent(agentId);
    if (row.killed_at) throw new HttpError(409, "killed", "The kill switch is on.");
    if (action === "take") return this.setLease(agentId, "owner", "owner");
    if (row.lease_holder !== "owner") return this.leaseOf(row);
    // A run that is still working (it did not ask for the takeover) gets the browser back; otherwise the agent stays
    // paused until its task continues.
    const working = await maybeOne(
      this.db,
      "select 1 from runs where agent_id = $1 and state in ('starting','running') and fenced_at is null",
      [agentId],
    );
    return this.setLease(agentId, working ? "agent" : "paused", "owner");
  }

  // Owner leases expire into "paused", never into "agent": a half-finished login stays out of the agent's reach.
  async expireLeases(): Promise<void> {
    const rows = await many<{ id: string }>(
      this.db,
      "select id from agents where added_at is not null and removing_at is null and lease_holder = 'owner' and lease_expires_at < now()",
    );
    for (const row of rows) {
      const expire = async () => {
        if (this.slots) await this.slots.require(row.id, false);
        await this.setLease(row.id, "paused", "system");
      };
      await (this.slots ? this.slots.exclusive(row.id, expire) : expire()).catch((error: unknown) =>
        this.log.warn({ err: String(error) }, "lease expiry failed"),
      );
    }
  }

  async setAttended(agentId: string, open: boolean): Promise<void> {
    const row = await this.agent(agentId);
    if (open) {
      if (row.killed_at) throw new HttpError(409, "killed", "The kill switch is on.");
      // Data from the last attended session must be gone before those sites are reachable again.
      await this.clearAttendedData(agentId);
    }
    await this.db.query("update agents set attended_open = $2 where id = $1", [agentId, open]);
    await this.policy.push();
    await this.audit.append(agentId, "owner", open ? "attended.opened" : "attended.closed", {});
    if (!open) {
      await this.db.query(
        "insert into kv (key, value) values ($1, 'true'::jsonb) on conflict (key) do update set value = 'true'::jsonb",
        [`attended_clear_pending:${agentId}`],
      );
      await this.clearAttendedData(agentId);
    }
  }

  // Removes cookies and storage of every site that matches an attended rule. Pending until it succeeds; retried by the
  // background sweep and before the next attended session opens.
  async clearAttendedData(agentId: string): Promise<void> {
    const pending = await maybeOne(this.db, "select 1 from kv where key = $1 and value = 'true'::jsonb", [`attended_clear_pending:${agentId}`]);
    if (!pending) return;
    const rules = await many<{ pattern: string }>(this.db, "select distinct pattern from domain_rules where agent_id = $1 and attended", [agentId]);
    if (rules.length > 0) {
      try {
        await this.handles(agentId).browser.clearSiteData(rules.map((r) => r.pattern));
      } catch (error) {
        throw new HttpError(502, "site_data_not_cleared", `The attended sites' data could not be cleared yet; Quokka Bot keeps retrying: ${String(error).slice(0, 200)}`);
      }
    }
    await this.db.query("update kv set value = 'false'::jsonb where key = $1", [`attended_clear_pending:${agentId}`]);
  }

  // The kill switch. Network first, then processes, then records; each step runs even if an earlier one failed, and
  // the first two need neither the database nor the job queue.
  async kill(agentId: string): Promise<{ errors: string[] }> {
    if (this.slots && !this.slots.knownIds.has(agentId)) throw new HttpError(404, "unknown_agent", "No such agent.");
    const errors: string[] = [];
    await this.egress.freeze(agentId).catch((error: unknown) => errors.push(`egress: ${String(error)}`));
    await this.supervisor.kill(agentId).catch((error: unknown) => errors.push(`supervisor: ${String(error)}`));
    try {
      await this.db.query("update agents set killed_at = coalesce(killed_at, now()), lease_holder = 'paused', lease_generation = lease_generation + 1, attended_open = false where id = $1", [agentId]);
      await this.db.query("update runs set token_revoked = true where agent_id = $1", [agentId]);
      await this.db.query(
        "insert into kv (key, value) values ($1, 'true'::jsonb) on conflict (key) do update set value = 'true'::jsonb",
        [`attended_clear_pending:${agentId}`],
      );
      const runs = await many<{ id: string; task_id: string; uncertain_mutations: number }>(
        this.db,
        "update runs set state = 'cancelled', ended_at = now() where agent_id = $1 and state in ('starting','running') returning id, task_id, uncertain_mutations",
        [agentId],
      );
      for (const run of runs) {
        const mutated = await maybeOne(this.db, "select 1 from browser_commands where run_id = $1 and op in ('open','navigate','click','type','select','check','press','download','back','forward','reload','close','fill_username','fill_password','fill_code') limit 1", [run.id]);
        await this.db.query(
          "update tasks set state = $2, blocked_reason = null, error = 'Stopped by the kill switch.', updated_at = now() where id = $1 and state in ('queued','running')",
          [run.task_id, mutated || run.uncertain_mutations > 0 ? "outcome_unknown" : "cancelled"],
        );
      }
      await this.db.query("update tasks set state = 'cancelled', error = 'Stopped by the kill switch.', updated_at = now() where agent_id = $1 and state = 'queued'", [agentId]);
      await this.policy.push().catch((error: unknown) => errors.push(`policy: ${String(error)}`));
      await this.audit.append(agentId, "owner", "kill.engaged", { errors: errors.length });
    } catch (error) {
      errors.push(`records: ${String(error)}`);
    }
    return { errors };
  }

  async releaseKill(agentId: string): Promise<void> {
    await this.agent(agentId);
    await this.supervisor.unlatch(agentId);
    await this.db.query("update agents set killed_at = null where id = $1", [agentId]);
    await this.policy.push();
    await this.audit.append(agentId, "owner", "kill.released", {});
  }
}
