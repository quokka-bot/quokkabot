import { ClaudeSignInCode, claudeSignInError, type ClaudeSignInStart, type ClaudeSignInStatus } from "@quokkabot/shared";
import { z } from "zod";
import type { AuditLog } from "./audit.js";
import type { AgentSlots } from "./agents.js";
import { UpstreamError, type SupervisorClient } from "./clients.js";
import type { ComputerService } from "./computer.js";
import { maybeOne, type Db } from "./db.js";
import { HttpError } from "./errors.js";

export class ClaudeSignIns {
  private readonly sessions = new Map<string, { agentId: string; generation: number; expiresAt: number }>();
  constructor(private readonly db: Db, private readonly supervisor: SupervisorClient, private readonly computer: ComputerService, private readonly audit: AuditLog, private readonly slots: AgentSlots) {}

  dropAgent(agentId: string): void {
    for (const [id, session] of this.sessions) if (session.agentId === agentId) this.sessions.delete(id);
  }

  // Upstream errors can contain CLI output. Return only the bounded message, never log the upstream body.
  private async call<T>(action: () => Promise<T>, code?: string): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof UpstreamError) {
        let message = "Claude sign-in failed. Start again.";
        try {
          const parsed = z.object({ message: z.string() }).parse(JSON.parse(error.body));
          message = claudeSignInError(parsed.message, code);
        } catch { /* An invalid upstream body must not reach the log. */ }
        throw new HttpError(error.status === 409 ? 409 : error.status === 404 ? 404 : 400, "claude_sign_in_failed", message);
      }
      throw new HttpError(502, "claude_sign_in_unavailable", "Could not reach Claude sign-in. Start again.");
    }
  }

  async start(agentId: string): Promise<ClaudeSignInStart> {
    // The owner route holds this slot's lock for the entire start operation.
    const slot = await this.slots.require(agentId, false);
    for (const [id, session] of this.sessions) if (session.expiresAt <= Date.now()) this.sessions.delete(id);
    const active = await maybeOne(this.db, "select 1 from tasks where agent_id = $1 and state = 'running' limit 1", [agentId]);
    if (active) throw new HttpError(409, "task_running", "Wait for the current task to finish");
    if (!(await this.computer.isRunning(agentId))) await this.computer.start(agentId);
    const result = await this.call(() => this.supervisor.startSignIn(agentId));
    this.dropAgent(agentId);
    this.sessions.set(result.signInId, { agentId, generation: slot.generation, expiresAt: Date.now() + 10 * 60_000 });
    return result;
  }

  async submit(signInId: string, input: unknown): Promise<ClaudeSignInStatus> {
    const parsed = ClaudeSignInCode.safeParse(input);
    if (!parsed.success) throw new HttpError(400, "invalid_code", "Paste the complete code from the Claude page");
    const session = this.sessions.get(signInId);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(signInId);
      throw new HttpError(404, "unknown_sign_in", "Sign-in expired or ended. Start again.");
    }
    return this.slots.exclusive(session.agentId, async () => {
      if (this.sessions.get(signInId) !== session || session.expiresAt <= Date.now()) {
        this.sessions.delete(signInId);
        throw new HttpError(404, "unknown_sign_in", "Sign-in expired or ended. Start again.");
      }
      await this.slots.require(session.agentId, false, session.generation);
      const status = await this.call(() => this.supervisor.submitSignIn(signInId, parsed.data.code), parsed.data.code);
      if (!status.loggedIn) throw new HttpError(400, "claude_sign_in_failed", "Claude is still signed out. Start again.");
      this.sessions.delete(signInId);
      const updated = await maybeOne(this.db,
        "update agents set cli_signed_in = 'yes', cli_account = $2, cli_plan = $3 where id = $1 and generation = $4 and added_at is not null and removing_at is null returning id",
        [session.agentId, status.email, status.subscriptionType, session.generation]);
      if (!updated) throw new HttpError(409, "agent_replaced", "This agent was removed. Reload to see the current agents.");
      await this.audit.append(session.agentId, "owner", "claude.signed_in", { email: status.email });
      return status;
    });
  }

  async cancel(signInId: string): Promise<void> {
    const session = this.sessions.get(signInId);
    if (!session) return;
    await this.slots.exclusive(session.agentId, async () => {
      if (this.sessions.get(signInId) !== session) return;
      await this.slots.require(session.agentId, false, session.generation);
      await this.call(() => this.supervisor.cancelSignIn(signInId));
      this.sessions.delete(signInId);
    });
  }
}
