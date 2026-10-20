import { randomUUID } from "node:crypto";
import {
  type BlockedReason,
  type DomainRequestId,
  type OwnerRequest,
  type ReactionEmoji,
  type ResultFile,
  type Run,
  type Task,
  type TaskEvent,
  TERMINAL_TASK_STATES,
  type TaskState,
  aiConsentStopped,
  siteLabel,
  hostMatchesPattern,
} from "@quokkabot/shared";
import { sha256Hex } from "@quokkabot/shared/node";
import type { Logger } from "pino";
import { attachmentPath, bindAttachments, runAttachments, runImage } from "./attachments.js";
import type { AuditLog } from "./audit.js";
import { newSecret } from "./auth.js";
import { ClaudeStreamParser, type ParsedResult, classifyExit } from "./claude-adapter.js";
import type { SupervisorClient } from "./clients.js";
import { UpstreamError } from "./clients.js";
import type { ComputerService } from "./computer.js";
import type { AiConsents } from "./consent.js";
import { type Db, many, maybeOne, one, withTx } from "./db.js";
import { HttpError } from "./errors.js";
import type { TaskEvents } from "./events.js";
import type { PolicyService } from "./policy.js";
import type { AgentSlots } from "./agents.js";

// How long a fenced run (the agent asked the owner something) may keep running before it is stopped.
const FENCE_GRACE_MS = 60_000;

export interface TaskRow {
  id: string;
  agent_id: string;
  title: string;
  prompt: string;
  state: TaskState;
  blocked_reason: BlockedReason | null;
  model: string;
  effort: string;
  session_id: string;
  session_started: boolean;
  pending_prompt: string | null;
  pending_attachment_ids: string[];
  result_summary: string | null;
  result_files: ResultFile[] | null;
  error: string | null;
  last_seq: number;
  created_at: Date;
  updated_at: Date;
}

export interface RunRow {
  id: string;
  task_id: string;
  agent_id: string;
  attempt: number;
  state: Run["state"];
  prompt: string;
  attachment_ids: string[];
  resume: boolean;
  exit_code: number | null;
  token_revoked: boolean;
  fenced_at: Date | null;
  fence_reason: string | null;
  output_offset: number;
  uncertain_mutations: number;
  started_at: Date;
  ended_at: Date | null;
  last_event_at: Date | null;
}

export function taskView(row: TaskRow): Task {
  return {
    id: row.id as Task["id"],
    agentId: row.agent_id as Task["agentId"],
    title: row.title,
    state: row.state,
    blockedReason: row.blocked_reason,
    model: row.model,
    effort: row.effort as Task["effort"],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    result: row.result_summary === null ? null : { summary: row.result_summary, files: row.result_files ?? [] },
    error: row.error,
  };
}

export function runView(row: RunRow): Run {
  return {
    id: row.id as Run["id"],
    taskId: row.task_id as Run["taskId"],
    attempt: row.attempt,
    state: row.state,
    exitCode: row.exit_code,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    lastEventAt: row.last_event_at?.toISOString() ?? null,
  };
}

export interface OwnerRequestRow {
  id: string;
  task_id: string;
  run_id: string;
  kind: "question" | "takeover" | "login" | "connect";
  text: string;
  what_to_do: string | null;
  site: string | null;
  login_name: string | null;
  login_id: string | null;
  connector: string | null;
  created_at: Date;
  answered_at: Date | null;
  answer: string | null;
}

export function ownerRequestView(row: OwnerRequestRow): OwnerRequest {
  return {
    id: row.id as OwnerRequest["id"],
    taskId: row.task_id as OwnerRequest["taskId"],
    runId: row.run_id as OwnerRequest["runId"],
    kind: row.kind,
    text: row.text,
    whatToDo: row.what_to_do,
    site: row.site,
    loginName: row.login_name,
    loginId: row.login_id as OwnerRequest["loginId"],
    connector: row.connector === "gmail" ? "gmail" : null,
    createdAt: row.created_at.toISOString(),
    answeredAt: row.answered_at?.toISOString() ?? null,
    answer: row.answer,
  };
}

function titleFrom(prompt: string): string {
  const first = prompt.trim().split("\n")[0] ?? "";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first || "Task";
}

export class TaskService {
  // Per-run parser state and the tail of stderr, kept while a watcher runs.
  private readonly watchers = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly events: TaskEvents,
    private readonly audit: AuditLog,
    private readonly supervisor: SupervisorClient,
    private readonly computer: ComputerService,
    private readonly policy: PolicyService,
    private readonly log: Logger,
    private readonly agentIds: () => string[] | Promise<string[]>,
    private readonly consents: AiConsents,
    private readonly slots?: AgentSlots,
  ) {}

  async get(taskId: string): Promise<TaskRow> {
    const row = await maybeOne<TaskRow>(this.db, "select * from tasks where id = $1", [taskId]);
    if (!row) throw new HttpError(404, "unknown_task", "No such task.");
    if (this.slots) await this.slots.require(row.agent_id);
    return row;
  }

  async react(taskId: string, reaction:
    | { by: "owner"; targetSeq: number; emoji: ReactionEmoji | null }
    | { by: "agent"; emoji: ReactionEmoji | null },
  ): Promise<void> {
    await this.get(taskId);
    const { by, emoji } = reaction;
    const changed = await withTx(this.db, async (tx) => {
      // Serialise storage changes with stream appends so replay and the current reaction table always agree.
      const task = await maybeOne<{ agent_id: string }>(tx, "select agent_id from tasks where id = $1 for update", [taskId]);
      if (!task) throw new HttpError(404, "unknown_task", "No such task.");
      const target = by === "owner"
        ? await maybeOne<{ seq: number; event: TaskEvent }>(tx, "select seq, event from task_events where task_id = $1 and seq = $2", [taskId, reaction.targetSeq])
        : await maybeOne<{ seq: number; event: TaskEvent }>(tx, "select seq, event from task_events where task_id = $1 and event->>'kind' = 'owner_message' order by seq desc limit 1", [taskId]);
      if (!target) throw new HttpError(404, "unknown_event", by === "owner" ? "No such message in this task." : "There is no owner message in this task.");
      if (by === "owner" && target.event.kind !== "assistant_text" && !(target.event.kind === "owner_request" && target.event.request.kind === "question")) {
        throw new HttpError(400, "invalid_reaction_target", "You can react only to an agent message or question.");
      }
      if (emoji === null) {
        await tx.query('delete from message_reactions where task_id = $1 and seq = $2 and "by" = $3', [taskId, target.seq, by]);
      } else {
        await tx.query(
          `insert into message_reactions (task_id, seq, "by", emoji) values ($1, $2, $3, $4)
           on conflict (task_id, seq, "by") do update set emoji = excluded.emoji`,
          [taskId, target.seq, by, emoji],
        );
      }
      await this.events.append(tx, taskId, { kind: "reaction", targetSeq: target.seq, by, emoji });
      return { agentId: task.agent_id, targetSeq: target.seq };
    });
    await this.audit.append(changed.agentId, by, "message.reaction_changed", { taskId, targetSeq: changed.targetSeq, by, emoji });
  }

  async create(agentId: string, prompt: string, idempotencyKey?: string, attachmentIds: string[] = []): Promise<TaskRow> {
    if (this.slots) await this.slots.require(agentId, false);
    const result = await withTx(this.db, async (tx) => {
      // The agent lock serialises keyed retries, including requests handled by another control process.
      const agent = await maybeOne<{ model: string; effort: string; killed_at: Date | null }>(
        tx, "select model, effort, killed_at from agents where id = $1 and added_at is not null and removing_at is null for update", [agentId],
      );
      if (!agent) throw new HttpError(404, "unknown_agent", "No such agent.");
      const keyHash = idempotencyKey === undefined ? null : sha256Hex(idempotencyKey);
      if (keyHash !== null) {
        const existing = await maybeOne<TaskRow>(tx,
          `select t.* from task_creation_keys k join tasks t on t.id = k.task_id
           where k.agent_id = $1 and k.key_hash = $2 and k.expires_at > now()`, [agentId, keyHash]);
        if (existing) return { task: existing, created: false };
        await tx.query("delete from task_creation_keys where expires_at <= now()");
      }
      if (agent.killed_at) throw new HttpError(409, "killed", "The kill switch is on. Release it first.");
      await this.consents.require(tx, agentId);
      const id = randomUUID();
      const created = await one<TaskRow>(
        tx,
        `insert into tasks (id, agent_id, title, prompt, state, model, effort, session_id, pending_prompt, pending_attachment_ids)
         values ($1, $2, $3, $4, 'queued', $5, $6, $7, $4, $8) returning *`,
        [id, agentId, titleFrom(prompt), prompt, agent.model, agent.effort, randomUUID(), attachmentIds],
      );
      if (keyHash !== null) {
        await tx.query(
          `insert into task_creation_keys (agent_id, key_hash, task_id, expires_at) values ($1, $2, $3, now() + interval '10 minutes')`,
          [agentId, keyHash, id],
        );
      }
      const attachments = await bindAttachments(tx, agentId, id, attachmentIds);
      await this.events.append(tx, id, { kind: "owner_message", text: prompt, attachments });
      await this.events.append(tx, id, { kind: "state", state: "queued", blockedReason: null });
      return { task: created, created: true };
    });
    if (result.created) {
      await this.audit.append(agentId, "owner", "task.created", { taskId: result.task.id, prompt: this.audit.textDigest(prompt) });
      this.kick();
    }
    return result.task;
  }

  // --- Owner actions ----------------------------------------------------------------------------------------------

  // The owner's message answers an open question; every other open card (a login, a takeover, Gmail, sites) is skipped:
  // it closes in the chat and the agent gets the message instead.
  async reply(taskId: string, text: string, attachmentIds: string[] = []): Promise<TaskRow> {
    const task = await this.get(taskId);
    const resolved = await withTx(this.db, async (tx) => {
      await this.consents.require(tx, task.agent_id);
      // UPDATE rechecks answered_at after waiting for a competing reply, so only the winner appends a message.
      const answered = await many<OwnerRequestRow>(tx,
        "update owner_requests set answered_at = now(), answer = $2 where task_id = $1 and answered_at is null returning *",
        [taskId, text]);
      const skippedSites = await many<{ id: string; domains: string[] }>(tx,
        "update domain_requests set decided_at = now(), decision = 'skip' where task_id = $1 and decided_at is null returning id, domains",
        [taskId]);
      answered.sort((a, b) => Number(b.kind === "question") - Number(a.kind === "question") || b.created_at.getTime() - a.created_at.getTime());
      const request = answered[0];
      if (!request && skippedSites.length === 0) throw new HttpError(409, "no_question", "This task is not waiting for an answer.");
      const asked = [
        ...answered.filter((row) => row.kind !== "question").map((row) =>
          row.kind === "login" ? `for a login (${row.site ?? "a site"})` : row.kind === "connect" ? "to connect Gmail" : "to take over the browser"),
        ...skippedSites.map((row) => `to allow ${row.domains.map(siteLabel).join(", ")}`),
      ];
      const question = request?.kind === "question" ? request : null;
      const prompt = question
        ? `The owner answered your question.\n\nQuestion: ${question.text}\nAnswer: ${text}${asked.length > 0 ? `\n\nYour other requests are closed (you asked ${asked.join("; ")}). Ask again only if you still need them.` : ""}`
        : `You asked the owner ${asked.join("; ")}. Instead, the owner wrote:\n${text}`;
      const row = await maybeOne<TaskRow>(tx,
        "update tasks set pending_prompt = $2, pending_attachment_ids = $3::uuid[], blocked_reason = null, updated_at = now() where id = $1 and state in ('queued','running') returning *",
        [taskId, prompt, attachmentIds]);
      if (!row) throw new HttpError(409, "task_inactive", "This task is no longer waiting for an answer.");
      const attachments = await bindAttachments(tx, task.agent_id, taskId, attachmentIds);
      if (answered.some((row) => row.kind === "takeover")) {
        const lease = await this.computer.lease(task.agent_id);
        if (lease.holder === "owner") await this.computer.takeover(task.agent_id, "return");
      }
      for (const site of skippedSites) {
        await this.events.append(tx, taskId, { kind: "domain_decided", requestId: site.id as DomainRequestId, decision: "skip", attended: false });
      }
      await this.events.append(tx, taskId, { kind: "owner_message", text, attachments });
      await this.events.append(tx, taskId, { kind: "state", state: row.state, blockedReason: null });
      return { task: row, requestIds: answered.map((request) => request.id), requestId: request?.id ?? null, skippedSites };
    });
    if (resolved.requestId !== null) {
      await this.audit.append(task.agent_id, "owner", "owner_request.answered", { requestId: resolved.requestId, requestIds: resolved.requestIds, answer: this.audit.textDigest(text) });
    }
    for (const site of resolved.skippedSites) {
      await this.audit.append(task.agent_id, "owner", "domain.decided", { requestId: site.id, decision: "skip", attended: false, domains: site.domains });
    }
    this.kick();
    return resolved.task;
  }

  async takeoverDone(taskId: string, note: string): Promise<TaskRow> {
    const task = await this.get(taskId);
    const request = await maybeOne<OwnerRequestRow>(
      this.db,
      "select * from owner_requests where task_id = $1 and kind = 'takeover' and answered_at is null order by created_at desc limit 1",
      [taskId],
    );
    if (!request) throw new HttpError(409, "no_takeover", "This task is not waiting for a takeover.");
    const lease = await this.computer.lease(task.agent_id);
    if (lease.holder === "owner") await this.computer.takeover(task.agent_id, "return");
    const message = `The owner finished the takeover you asked for ("${request.what_to_do ?? request.text}").${
      note ? ` Their note: ${note}` : ""
    } Take a fresh snapshot before you continue.`;
    const updated = await withTx(this.db, async (tx) => {
      await this.consents.require(tx, task.agent_id);
      await tx.query("update owner_requests set answered_at = now(), answer = $2 where id = $1", [request.id, note || "done"]);
      if (note) await this.events.append(tx, taskId, { kind: "owner_message", text: note, attachments: [] });
      const row = await one<TaskRow>(
        tx,
        "update tasks set pending_prompt = $2, blocked_reason = null, updated_at = now() where id = $1 and state in ('queued','running') returning *",
        [taskId, message],
      );
      await this.events.append(tx, taskId, { kind: "state", state: row.state, blockedReason: null });
      return row;
    });
    await this.audit.append(task.agent_id, "owner", "owner_request.answered", { requestId: request.id, takeover: true });
    this.kick();
    return updated;
  }

  // A follow-up on a finished task starts a new CLI session: the old transcript was deleted when the task ended. The new
  // session gets the original request, how it ended and the follow-up.
  async message(taskId: string, text: string, attachmentIds: string[] = []): Promise<TaskRow> {
    const task = await this.get(taskId);
    if (!TERMINAL_TASK_STATES.has(task.state)) {
      throw new HttpError(409, "task_active", "The task is still running. Answer its question or wait for it to finish.");
    }
    const context = [
      "You are continuing an earlier task for the owner. Your files and downloads from it are still on your computer.",
      `The original request:\n${task.prompt}`,
      task.result_summary ? `How it ended: ${task.state}. Your result:\n${task.result_summary}` : `How it ended: ${task.state}${task.error ? ` (${task.error})` : ""}.`,
      `The owner now says:\n${text}`,
    ].join("\n\n");
    const updated = await withTx(this.db, async (tx) => {
      await this.consents.require(tx, task.agent_id);
      const locked = await one<TaskRow>(tx, "select * from tasks where id = $1 for update", [taskId]);
      if (!TERMINAL_TASK_STATES.has(locked.state)) throw new HttpError(409, "task_active", "The task is still running.");
      const attachments = await bindAttachments(tx, task.agent_id, taskId, attachmentIds);
      await this.events.append(tx, taskId, { kind: "owner_message", text, attachments });
      const row = await one<TaskRow>(
        tx,
        `update tasks set state = 'queued', pending_prompt = $2, pending_attachment_ids = $4::uuid[], session_id = $3, session_started = false, blocked_reason = null,
           error = null, result_summary = null, result_files = null, updated_at = now() where id = $1 returning *`,
        [taskId, context, randomUUID(), attachmentIds],
      );
      await this.events.append(tx, taskId, { kind: "state", state: "queued", blockedReason: null });
      return row;
    });
    await this.audit.append(task.agent_id, "owner", "task.state_changed", { taskId, state: "queued", followUp: this.audit.textDigest(text) });
    this.kick();
    return updated;
  }

  async cancel(taskId: string): Promise<TaskRow> {
    const task = await this.get(taskId);
    if (TERMINAL_TASK_STATES.has(task.state)) return task;
    const run = await maybeOne<RunRow>(this.db, "select * from runs where task_id = $1 and state in ('starting','running')", [taskId]);
    if (run) {
      await this.db.query("update runs set fence_reason = 'cancelled', fenced_at = coalesce(fenced_at, now()) where id = $1", [run.id]);
      await this.supervisor.cancelRun(run.id);
      return task; // the watcher finalises it as cancelled
    }
    await this.finishTask(task, "cancelled", null, "Cancelled by the owner.");
    return this.get(taskId);
  }

  async cancelAgent(agentId: string): Promise<void> {
    if (this.slots) await this.slots.require(agentId);
    // Normal cancellation cleans transcripts and task grants. Removal keeps them until every revoke is confirmed.
    const runs = await withTx(this.db, async (tx) => {
      await tx.query("update runs set token_revoked = true, fence_reason = 'agent_removing', fenced_at = coalesce(fenced_at, now()) where agent_id = $1", [agentId]);
      const cancelled = await many<TaskRow>(tx,
        "update tasks set state = 'cancelled', pending_prompt = null, blocked_reason = null, error = 'Cancelled for agent removal.', updated_at = now() where agent_id = $1 and state in ('queued','running') returning *", [agentId]);
      await tx.query("update domain_requests set decided_at = now(), decision = 'refuse' where agent_id = $1 and decided_at is null", [agentId]);
      for (const task of cancelled) await this.events.append(tx, task.id, { kind: "state", state: "cancelled", blockedReason: null });
      return many<RunRow>(tx, "select * from runs where agent_id = $1 and state in ('starting','running')", [agentId]);
    });
    const deadline = Date.now() + 30_000;
    for (const run of runs) {
      await this.supervisor.cancelRun(run.id).catch((error: unknown) => {
        if (!(error instanceof UpstreamError && error.status === 404)) throw error;
      });
      for (;;) {
        const status = await this.supervisor.run(run.id).catch((error: unknown) => {
          if (error instanceof UpstreamError && error.status === 404) return null;
          throw error;
        });
        if (!status || !["starting", "running"].includes(status.state)) break;
        if (Date.now() >= deadline) throw new HttpError(409, "agent_busy", "The task is still stopping. Retry Remove agent.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      this.watch(run);
    }
    const watchers = await many<{ id: string }>(this.db, "select id from runs where agent_id = $1", [agentId]);
    for (const run of watchers) {
      const watcher = this.watchers.get(run.id);
      if (!watcher) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([watcher, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new HttpError(409, "agent_busy", "The task is still stopping. Retry Remove agent.")), 30_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
  }

  // --- Dispatch ----------------------------------------------------------------------------------------------------

  private kicking = false;
  private kickAgain = false;

  kick(): void {
    if (this.kicking) {
      this.kickAgain = true;
      return;
    }
    this.kicking = true;
    void this.dispatch()
      .catch((error: unknown) => this.log.error({ err: String(error) }, "dispatch failed"))
      .finally(() => {
        this.kicking = false;
        if (this.kickAgain) {
          this.kickAgain = false;
          this.kick();
        }
      });
  }

  private async dispatch(): Promise<void> {
    for (const agentId of await this.agentIds()) {
      if (this.slots) await this.slots.exclusive(agentId, () => this.dispatchAgent(agentId));
      else await this.dispatchAgent(agentId);
    }
  }

  private async dispatchAgent(agentId: string): Promise<void> {
    const agent = await maybeOne<{ killed_at: Date | null; lease_holder: string }>(this.db, "select killed_at, lease_holder from agents where id = $1 and added_at is not null and removing_at is null", [agentId]);
    if (!agent || agent.killed_at) return;
    // A withdrawn permission stops everything the agent has queued or running, whichever app queued it. Withdrawing
    // does this at once; dispatch repeats it so a withdrawal that crashed half-way is still enforced.
    if ((await this.consents.view(this.db, agentId)).state === "withdrawn") {
      await this.stopWithoutConsent(agentId);
      return;
    }
    // A run that ended but is not finalized still decides its task's next state; the next run waits for it, or both
    // would act on the task at once (the old finalizer completing a task its successor is working on).
    const active = await maybeOne(
      this.db,
      "select 1 from runs where agent_id = $1 and not diagnostic and (state in ('starting','running') or not finalized)",
      [agentId],
    );
    if (active) return;
    // While the owner holds the browser, nothing new starts; the owner hands it back first.
    if (agent.lease_holder === "owner") return;
    const task = await maybeOne<TaskRow>(
      this.db,
      "select * from tasks where agent_id = $1 and pending_prompt is not null and state in ('queued','running') order by updated_at limit 1",
      [agentId],
    );
    if (task) await this.startRun(task);
  }

  private async startRun(task: TaskRow): Promise<void> {
    const prompt = task.pending_prompt;
    if (prompt === null) return;
    try {
      if (!(await this.computer.isRunning(task.agent_id).catch(() => false))) {
        await this.computer.start(task.agent_id);
      }
      await this.supervisor.resetTools(task.agent_id);
      await this.computer.setLease(task.agent_id, "agent", "system");
    } catch (error) {
      await this.finishTask(task, "failed", null, `The computer did not start: ${errorText(error)}`);
      return;
    }
    const runId = randomUUID();
    const token = newSecret();
    const prepared = await withTx(this.db, async (tx) => {
      const current = await one<TaskRow>(tx, "select * from tasks where id = $1 for update", [task.id]);
      if (current.pending_prompt === null || TERMINAL_TASK_STATES.has(current.state)) return null;
      // No consent, no run: checked with the agent row held shared, so a withdrawal waits for this transaction and
      // then sees the run it must stop.
      const consent = await this.consents.view(tx, task.agent_id, "share");
      if (!consent.allowed) return { refused: consent.state };
      const attachments = await runAttachments(tx, current.id, current.pending_attachment_ids);
      const prompt = current.pending_prompt + (attachments.length > 0 ? `\n\nOwner images saved in your workspace: ${attachments.map(attachmentPath).join(", ")}` : "");
      const attempt = await one<{ n: number }>(tx, "select count(*)::int + 1 as n from runs where task_id = $1", [task.id]);
      const run = await one<RunRow>(
        tx,
        `insert into runs (id, task_id, agent_id, attempt, state, prompt, resume, mcp_token_hash, attachment_ids)
         values ($1, $2, $3, $4, 'starting', $5, $6, $7, $8) returning *`,
        [runId, task.id, task.agent_id, attempt.n, prompt, current.session_started, sha256Hex(token), current.pending_attachment_ids],
      );
      await tx.query("update tasks set state = 'running', blocked_reason = null, pending_prompt = null, pending_attachment_ids = '{}', updated_at = now() where id = $1", [task.id]);
      await this.events.append(tx, task.id, { kind: "state", state: "running", blockedReason: null });
      await this.events.append(tx, task.id, { kind: "run", run: runView(run) });
      return { run, task: current, prompt, attachments };
    });
    if (prepared === null) return;
    if ("refused" in prepared) {
      if (prepared.refused === "withdrawn") await this.stopWithoutConsent(task.agent_id);
      else await this.finishTask(await this.get(task.id), "cancelled", null, aiConsentStopped(prepared.refused));
      return;
    }
    const { run, attachments } = prepared;
    task = prepared.task;
    await this.policy.push().catch((error: unknown) => this.log.warn({ err: String(error) }, "policy push failed"));
    // A withdrawal between the transaction above and here fenced the run: it never reaches the CLI.
    if (await this.consentFenced(runId)) {
      await this.finalizeRun(runId, null, null, "", "cancelled");
      return;
    }
    try {
      for (const attachment of attachments) {
        await this.supervisor.writeWorkspaceFile(task.agent_id, attachmentPath(attachment), attachment.data);
      }
      await this.supervisor.startRun(task.agent_id, {
        runId: runId as never,
        sessionId: task.session_id,
        resume: task.session_started,
        model: task.model,
        effort: task.effort as never,
        mcpToken: token,
        prompt: prepared.prompt,
        images: attachments.map(runImage),
      });
    } catch (error) {
      // The supervisor may have started it before the reply was lost: ask before giving up.
      const known = await this.supervisor.run(runId).catch(() => null);
      if (!known) {
        await this.db.query("update runs set state = 'lost', ended_at = now(), token_revoked = true where id = $1", [runId]);
        await this.finishTask(await this.get(task.id), "failed", null, `The CLI did not start: ${errorText(error)}`);
        return;
      }
    }
    await this.db.query("update runs set state = 'running' where id = $1 and state = 'starting'", [runId]);
    await this.db.query("update tasks set session_started = true where id = $1", [task.id]);
    // A withdrawal while the CLI was starting could not cancel it yet; stop it now. The watcher ends the task.
    if (await this.consentFenced(runId)) await this.supervisor.cancelRun(runId).catch((error: unknown) => this.log.warn({ err: String(error), runId }, "cancelling a run without consent failed"));
    await this.audit.append(task.agent_id, "system", "run.started", { taskId: task.id, runId, attempt: run.attempt, resume: run.resume });
    this.watch({ ...run, state: "running" });
  }

  private async consentFenced(runId: string): Promise<boolean> {
    const row = await maybeOne<{ fence_reason: string | null }>(this.db, "select fence_reason from runs where id = $1", [runId]);
    return row?.fence_reason === "ai_consent";
  }

  // Ends everything an agent has queued or running once its permission to send to the AI provider is withdrawn:
  // active runs are fenced (their tool token revoked) and cancelled, every other open task ends. Runs that are still
  // starting are left to startRun, which checks the fence before and after it starts the CLI.
  async stopWithoutConsent(agentId: string): Promise<void> {
    const stopped = await withTx(this.db, async (tx) => {
      const consent = await this.consents.view(tx, agentId, "share");
      if (consent.state !== "withdrawn") return null;
      const runs = await many<RunRow>(tx,
        `update runs set fence_reason = 'ai_consent', fenced_at = coalesce(fenced_at, now()), token_revoked = true
         where agent_id = $1 and state in ('starting','running') and not diagnostic and fence_reason is distinct from 'ai_consent'
         returning *`, [agentId]);
      const idle = await many<TaskRow>(tx,
        `select * from tasks t where agent_id = $1 and state in ('queued','running')
         and not exists (select 1 from runs r where r.task_id = t.id and r.state in ('starting','running'))`, [agentId]);
      return { runs, idle };
    });
    if (stopped === null) return;
    for (const run of stopped.runs) {
      if (run.state !== "running") continue;
      await this.supervisor.cancelRun(run.id).catch((error: unknown) => {
        if (!(error instanceof UpstreamError && error.status === 404)) this.log.warn({ err: String(error), runId: run.id }, "cancelling a run without consent failed");
      });
      this.watch(run);
    }
    for (const task of stopped.idle) await this.finishTask(task, "cancelled", null, aiConsentStopped("withdrawn"));
  }

  // --- Watching a run's output ------------------------------------------------------------------------------------

  watch(run: RunRow): void {
    if (this.watchers.has(run.id)) return;
    const promise = this.followRun(run)
      .catch((error: unknown) => {
        // A transient failure (database restart) must not strand the run: reconcile() picks it up again.
        this.log.error({ err: String(error), runId: run.id }, "run watcher failed; it will be retried");
      })
      .finally(() => this.watchers.delete(run.id));
    this.watchers.set(run.id, promise);
  }

  // Runs on startup and every 30 s: follows active runs that have no watcher and finalises runs that ended without a
  // decided task (a crash between the two).
  async reconcile(): Promise<void> {
    const ids = await this.agentIds();
    for (const id of ids) {
      const reconcile = async () => {
        if (this.slots) {
          if (!this.slots.knownIds.has(id)) return;
          if ((await this.slots.require(id)).removing_at) return;
        }
        const active = await many<RunRow>(this.db, "select * from runs where state in ('starting','running') and not diagnostic and agent_id = $1", [id]);
        for (const run of active) this.watch(run);
        const unfinished = await many<RunRow>(this.db, "select * from runs where state not in ('starting','running') and not finalized and not diagnostic and agent_id = $1", [id]);
        for (const run of unfinished) {
          if (this.watchers.has(run.id)) continue;
          await this.finalizeRun(run.id, run.exit_code, null, "", run.state === "cancelled" ? "cancelled" : run.state === "lost" ? "lost" : "exited").catch(
            (error: unknown) => this.log.error({ err: String(error), runId: run.id }, "finalising a run failed"),
          );
        }
      };
      if (this.slots) await this.slots.exclusive(id, reconcile);
      else await reconcile();
    }
    this.kick();
  }

  private async followRun(run: RunRow): Promise<void> {
    const parser = new ClaudeStreamParser();
    let offset = 0;
    let result: ParsedResult | null = null;
    const stderrTail: string[] = [];
    let replaying = run.output_offset > 0;
    while (!this.stopped) {
      let lines;
      try {
        lines = await this.supervisor.runOutput(run.id, offset, 20);
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) {
          await this.finalizeRun(run.id, null, null, stderrTail.join("\n"), "lost");
          return;
        }
        await sleep(2000);
        continue;
      }
      for (const line of lines) {
        offset = line.n + 1;
        if (line.stream === "stderr") {
          stderrTail.push(line.line.slice(0, 500));
          if (stderrTail.length > 20) stderrTail.shift();
          continue;
        }
        const parsed = parser.parseLine(line.line);
        if (parsed.result) result = parsed.result;
        // After a restart, lines before the stored offset only rebuild the parser state.
        if (replaying && line.n < run.output_offset) continue;
        replaying = false;
        for (const event of parsed.events) await this.events.append(this.db, run.task_id, event);
        if (parsed.mcpFailed) {
          this.log.error({ runId: run.id }, "Quokka Bot MCP server not connected in the CLI");
          await this.db.query("update runs set mcp_failed = true where id = $1", [run.id]);
        }
      }
      if (lines.length > 0) {
        await this.db.query("update runs set output_offset = greatest(output_offset, $2), last_event_at = now() where id = $1", [run.id, offset]);
        continue;
      }
      await this.enforceFence(run.id);
      const status = await this.supervisor.run(run.id).catch(() => null);
      if (status && (status.state === "exited" || status.state === "cancelled" || status.state === "lost") && offset >= status.lines) {
        await this.finalizeRun(run.id, status.exitCode, result, stderrTail.join("\n"), status.state);
        return;
      }
    }
  }

  private async enforceFence(runId: string): Promise<void> {
    const run = await maybeOne<RunRow>(this.db, "select * from runs where id = $1", [runId]);
    if (!run?.fenced_at || run.fence_reason === "cancelled") return;
    // A run stopped for a withdrawn permission is cancelled again until the supervisor reports it ended.
    if (run.fence_reason === "ai_consent") {
      await this.supervisor.cancelRun(runId).catch(() => undefined);
      return;
    }
    if (Date.now() - run.fenced_at.getTime() > FENCE_GRACE_MS) {
      this.log.info({ runId }, "fenced run did not end its turn; stopping it");
      await this.supervisor.cancelRun(runId).catch(() => undefined);
    }
  }

  private async finalizeRun(
    runId: string,
    exitCode: number | null,
    result: ParsedResult | null,
    stderrTail: string,
    supervisorState: "exited" | "cancelled" | "lost",
  ): Promise<void> {
    const run = await one<RunRow & { finalized: boolean; mcp_failed: boolean; final_result: ParsedResult | null }>(this.db, "select * from runs where id = $1", [runId]);
    if (run.finalized) return;
    const cancelledByOwner = run.fence_reason === "cancelled";
    const stoppedWithoutConsent = run.fence_reason === "ai_consent";
    const stillActive = run.state === "running" || run.state === "starting";
    const finalState: Run["state"] = stillActive
      ? cancelledByOwner || stoppedWithoutConsent || supervisorState === "cancelled" ? "cancelled" : supervisorState === "lost" ? "lost" : "exited"
      : run.state;
    const finalResult = result ?? run.final_result;
    const ended = await one<RunRow>(
      this.db,
      `update runs set state = $2, exit_code = coalesce($3, exit_code), final_result = coalesce($4, final_result), token_revoked = true,
         ended_at = coalesce(ended_at, now()) where id = $1 returning *`,
      [runId, finalState, exitCode, finalResult ? JSON.stringify(finalResult) : null],
    );
    const task = await this.get(run.task_id);
    if (stillActive) {
      await this.events.append(this.db, task.id, { kind: "run", run: runView(ended) });
      await this.audit.append(task.agent_id, "system", "run.exited", { runId, state: finalState, exitCode });
    }
    const lease = await this.computer.lease(task.agent_id);
    if (lease.holder === "agent") await this.computer.setLease(task.agent_id, "paused", "system").catch(() => undefined);
    const markFinalized = (): Promise<unknown> => this.db.query("update runs set finalized = true where id = $1", [runId]);

    if (cancelledByOwner) {
      await this.finishTask(task, (await this.uncertainCount(task.id)) > 0 ? "outcome_unknown" : "cancelled", null, "Cancelled by the owner.");
      return;
    }
    if (stoppedWithoutConsent) {
      await this.finishTask(task, (await this.uncertainCount(task.id)) > 0 ? "outcome_unknown" : "cancelled", null, aiConsentStopped("withdrawn"));
      return;
    }
    if (TERMINAL_TASK_STATES.has(task.state)) {
      await markFinalized();
      return;
    }
    const exit = classifyExit(finalState === "lost" ? null : ended.exit_code, finalResult, stderrTail);
    if (exit.kind === "failed" && exit.signedOut) {
      await this.db.query("update agents set cli_signed_in = 'no', cli_account = null, cli_plan = null where id = $1", [task.agent_id]);
      await this.finishTask(task, "failed", null, "Claude Code is signed out. Sign in to Claude, then try again.");
      return;
    }
    if (exit.kind === "failed" && exit.planLimit) {
      await this.finishTask(task, "failed", null, `Your Claude plan limit is reached: ${exit.reason}`);
      return;
    }
    if (exit.kind === "completed") await this.db.query("update agents set cli_signed_in = 'yes' where id = $1", [task.agent_id]);

    // The owner already answered while the CLI was shutting down: that answer is the next run, not the end.
    if (task.pending_prompt !== null) {
      await this.db.query("update tasks set blocked_reason = null, updated_at = now() where id = $1", [task.id]);
      await markFinalized();
      this.kick();
      return;
    }
    // The agent asked the owner something: the task waits, whatever the CLI's exit looked like.
    const openRequest = await maybeOne<OwnerRequestRow>(
      this.db,
      "select * from owner_requests where task_id = $1 and answered_at is null order by created_at desc limit 1",
      [task.id],
    );
    const openDomains = await maybeOne(this.db, "select 1 from domain_requests where task_id = $1 and decided_at is null limit 1", [task.id]);
    if (openRequest || openDomains) {
      const reason: BlockedReason = openRequest ? (openRequest.kind === "takeover" ? "takeover" : "waiting_for_owner") : "domain_request";
      await this.db.query("update tasks set blocked_reason = $2, updated_at = now() where id = $1", [task.id, reason]);
      await this.events.append(this.db, task.id, { kind: "state", state: "running", blockedReason: reason });
      await markFinalized();
      await this.policy.push().catch(() => undefined);
      return;
    }
    if (run.mcp_failed) {
      await this.finishTask(task, "failed", null, "Quokka Bot's tools were not connected to Claude Code, so nothing it reported could be checked.", true);
      return;
    }
    const uncertain = await this.uncertainCount(task.id);
    if (exit.kind === "completed") {
      if (uncertain > 0) {
        await this.finishTask(task, "outcome_unknown", exit.text, `${uncertain} browser action(s) ended without a definite result. Check the destination before repeating anything.`, true);
      } else {
        await this.attachDownloadsIfMissing(task.id);
        await this.finishTask(task, "completed", exit.text, null, true);
      }
      return;
    }
    if (exit.kind === "lost") {
      const mutated = await maybeOne(this.db, "select 1 from browser_commands c join runs r on r.id = c.run_id where r.task_id = $1 and c.op not in ('tabs','snapshot','screenshot','wait') limit 1", [task.id]);
      await this.finishTask(task, mutated ? "outcome_unknown" : "failed", null, "The CLI process was lost.", true);
      return;
    }
    await this.finishTask(task, uncertain > 0 ? "outcome_unknown" : "failed", null, exit.reason, true);
  }

  // Browser actions of uncertain outcome anywhere in the task: reported as uncertain, or dispatched with no recorded
  // answer at all (control stopped between sending and recording).
  private async uncertainCount(taskId: string): Promise<number> {
    const row = await one<{ n: number }>(
      this.db,
      `select (select coalesce(sum(uncertain_mutations), 0) from runs where task_id = $1)
            + (select count(*) from browser_commands c join runs r on r.id = c.run_id
               where r.task_id = $1 and c.status is null and c.op not in ('tabs','snapshot','screenshot','wait')) as n`,
      [taskId],
    );
    return Number(row.n);
  }

  // Files the task downloaded are its evidence when the agent did not attach any itself.
  private async attachDownloadsIfMissing(taskId: string): Promise<void> {
    const task = await this.get(taskId);
    if (task.result_files !== null) return;
    const files = await many<{ id: string; name: string; bytes: number; sha256: string }>(
      this.db,
      "select id, name, bytes, sha256 from files where task_id = $1 and scope = 'downloads' order by created_at",
      [taskId],
    );
    if (files.length === 0) return;
    const resultFiles: ResultFile[] = files.map((f) => ({ fileId: f.id as ResultFile["fileId"], name: f.name, bytes: f.bytes, sha256: f.sha256, scope: "downloads" }));
    await this.db.query("update tasks set result_files = $2 where id = $1", [taskId, JSON.stringify(resultFiles)]);
  }

  // `unlessResumed`: the run's exit ends the task only if the owner did not answer in the meantime (an answer, a saved
  // login or a finished takeover sets pending_prompt atomically with answering the request). Owner actions that end a
  // task (cancel, sign-out, plan limit) pass false.
  private async finishTask(task: TaskRow, state: TaskState, resultText: string | null, error: string | null, unlessResumed = false): Promise<void> {
    const row = await maybeOne<TaskRow>(
      this.db,
      `update tasks set state = $2, blocked_reason = null, pending_prompt = null, error = $3,
         result_summary = coalesce(result_summary, $4), updated_at = now()
       where id = $1 and ($5::boolean is false or pending_prompt is null) returning *`,
      [task.id, state, error, resultText, unlessResumed],
    );
    if (!row) {
      await this.db.query("update tasks set blocked_reason = null, updated_at = now() where id = $1", [task.id]);
      await this.db.query("update runs set finalized = true where task_id = $1 and state not in ('starting','running')", [task.id]);
      this.kick();
      return;
    }
    await this.events.append(this.db, task.id, { kind: "state", state, blockedReason: null });
    if (error) await this.events.append(this.db, task.id, { kind: "error", message: error });
    await this.audit.append(task.agent_id, "system", "task.state_changed", { taskId: task.id, state });
    // Task-scoped site grants end with the task; the CLI's transcript of a finished task is deleted.
    await this.db.query("delete from domain_rules where task_id = $1", [task.id]);
    await this.db.query("update owner_requests set answered_at = now(), answer = '(task ended)' where task_id = $1 and answered_at is null", [task.id]);
    await this.db.query("update domain_requests set decided_at = now(), decision = 'refuse' where task_id = $1 and decided_at is null", [task.id]);
    await this.db.query("update runs set finalized = true where task_id = $1 and state not in ('starting','running')", [task.id]);
    // Nothing the task started keeps running or keeps its transcript: tool processes are killed, and every run's CLI
    // session files and raw output are deleted.
    await this.supervisor.resetTools(task.agent_id).catch((e: unknown) => this.log.warn({ err: String(e) }, "tools reset failed"));
    const runs = await many<{ id: string }>(this.db, "select id from runs where task_id = $1 and state not in ('starting','running')", [task.id]);
    for (const run of runs) {
      await this.supervisor.cleanupRun(task.agent_id, run.id, row.session_id).catch((e: unknown) =>
        this.log.warn({ err: String(e), runId: run.id }, "run cleanup failed"),
      );
    }
    await this.policy.push().catch(() => undefined);
    this.kick();
  }

  // A login the owner saved answers every open "login" request of that agent whose site it covers.
  async loginSaved(agentId: string, login: { id: string; name: string; sites: string[] }): Promise<void> {
    const open = await many<OwnerRequestRow & { agent_id: string }>(
      this.db,
      `select o.*, t.agent_id from owner_requests o join tasks t on t.id = o.task_id
       where o.kind = 'login' and o.answered_at is null and t.agent_id = $1 and t.state in ('queued','running')`,
      [agentId],
    );
    for (const request of open) {
      const site = request.site ?? "";
      const covers = request.login_id !== null
        ? request.login_id === login.id
        : login.sites.some((pattern) => hostMatchesPattern(site.replace(/^\*\./, ""), pattern) || pattern === site);
      if (!covers) continue;
      const message = request.login_id !== null
        ? `The owner updated the login "${login.name}" (login_id ${login.id}). Sign in again with browser_fill_login (and browser_fill_code if the site asks for a 2FA code), then continue.`
        : `The owner saved the login "${login.name}" (login_id ${login.id}) for ${site}. Sign in with browser_fill_login (and browser_fill_code if the site asks for a 2FA code), then continue.`;
      await withTx(this.db, async (tx) => {
        const answered = await tx.query("update owner_requests set answered_at = now(), answer = $2 where id = $1 and answered_at is null", [request.id, `Saved login ${login.name}`]);
        if (answered.rowCount !== 1) return;
        await tx.query("update tasks set pending_prompt = $2, blocked_reason = null, updated_at = now() where id = $1", [request.task_id, message]);
        await this.events.append(tx, request.task_id, { kind: "owner_message", text: request.login_id !== null ? `Updated the login "${login.name}".` : `Saved the login "${login.name}".`, attachments: [] });
        await this.events.append(tx, request.task_id, { kind: "state", state: "running", blockedReason: null });
      });
      await this.audit.append(agentId, "owner", "owner_request.answered", { requestId: request.id, login: login.id });
    }
    this.kick();
  }

  // The owner connected an app: every open "connect" request of that agent for it is answered and its task resumes.
  async connectorConnected(agentId: string, app: "gmail", account: string): Promise<void> {
    const open = await many<OwnerRequestRow>(
      this.db,
      `select o.* from owner_requests o join tasks t on t.id = o.task_id
       where o.kind = 'connect' and o.connector = $2 and o.answered_at is null and t.agent_id = $1 and t.state in ('queued','running')`,
      [agentId, app],
    );
    for (const request of open) {
      const message = `The owner connected Gmail (${account}). Use gmail_search, gmail_read and gmail_create_draft, then continue.`;
      const claimed = await withTx(this.db, async (tx) => {
        const answered = await tx.query("update owner_requests set answered_at = now(), answer = $2 where id = $1 and answered_at is null", [request.id, `Connected ${account}`]);
        if (answered.rowCount !== 1) return false;
        await tx.query("update tasks set pending_prompt = $2, blocked_reason = null, updated_at = now() where id = $1", [request.task_id, message]);
        await this.events.append(tx, request.task_id, { kind: "owner_message", text: `Connected Gmail (${account}).`, attachments: [] });
        await this.events.append(tx, request.task_id, { kind: "state", state: "running", blockedReason: null });
        return true;
      });
      if (claimed) await this.audit.append(agentId, "owner", "owner_request.answered", { requestId: request.id, connector: app });
    }
    this.kick();
  }

  // The owner prefers to sign in themselves: the login request becomes a takeover of the browser, and handing control
  // back resumes the agent the same way as any takeover.
  async signInMyself(requestId: string): Promise<void> {
    const request = await maybeOne<OwnerRequestRow & { agent_id: string; state: string }>(
      this.db,
      "select o.*, t.agent_id, t.state from owner_requests o join tasks t on t.id = o.task_id where o.id = $1",
      [requestId],
    );
    if (!request || request.kind !== "login" || request.answered_at !== null || !["queued", "running"].includes(request.state)) {
      throw new HttpError(409, "not_open", "This login request is no longer open.");
    }
    const whatToDo = `Sign in to ${request.site ?? "the site"} in the browser, then hand control back.`;
    await withTx(this.db, async (tx) => {
      const row = await one<OwnerRequestRow>(
        tx,
        "update owner_requests set kind = 'takeover', what_to_do = $2 where id = $1 returning *",
        [requestId, whatToDo],
      );
      await tx.query("update tasks set blocked_reason = 'takeover', updated_at = now() where id = $1", [request.task_id]);
      await this.events.append(tx, request.task_id, { kind: "owner_request", request: ownerRequestView(row) });
      await this.events.append(tx, request.task_id, { kind: "state", state: "running", blockedReason: "takeover" });
    });
    await this.audit.append(request.agent_id, "owner", "owner_request.answered", { requestId, signInMyself: true });
  }

  // --- Called by MCP tools -------------------------------------------------------------------------------------------

  async fence(runId: string, reason: "question" | "takeover" | "domain_request" | "login"): Promise<void> {
    await this.db.query("update runs set fenced_at = coalesce(fenced_at, now()), fence_reason = coalesce(fence_reason, $2) where id = $1", [runId, reason]);
  }

  async attachResult(taskId: string, summary: string, files: ResultFile[]): Promise<void> {
    await this.db.query("update tasks set result_summary = $2, result_files = $3, updated_at = now() where id = $1", [
      taskId,
      summary,
      JSON.stringify(files),
    ]);
  }

  // Site decisions resume a task parked on its site requests once none is open. The run that asked may still be
  // ending its turn after the wait (fenced): the decisions then wait as its next prompt. Every decision the agent has
  // not been told goes into that prompt.
  async domainDecided(taskId: string | null): Promise<void> {
    if (!taskId) return;
    const resumed = await withTx(this.db, async (tx) => {
      const task = await maybeOne<TaskRow>(tx, "select * from tasks where id = $1 for update", [taskId]);
      if (!task || task.state !== "running" || task.blocked_reason !== "domain_request") return false;
      const working = await maybeOne(tx, "select 1 from runs where task_id = $1 and state in ('starting','running') and fenced_at is null limit 1", [taskId]);
      if (working) return false;
      const stillOpen = await maybeOne(tx, "select 1 from domain_requests where task_id = $1 and decided_at is null limit 1", [taskId]);
      if (stillOpen) return false;
      const decided = await many<{ domains: string[]; decision: string; attended: boolean }>(
        tx,
        `update domain_requests set reported = true where task_id = $1 and not reported and decision in ('allow_task', 'allow_always', 'refuse')
         returning domains, decision, attended`,
        [taskId],
      );
      if (decided.length === 0) throw new Error(`task ${taskId} is parked on site requests, but none has an unreported decision`);
      const allowed = decided.some((row) => row.decision !== "refuse");
      await tx.query("update tasks set pending_prompt = $2, blocked_reason = null, updated_at = now() where id = $1", [taskId, `${siteDecisionText(decided)}${allowed ? " Continue." : ""}`]);
      await this.events.append(tx, taskId, { kind: "state", state: "running", blockedReason: null });
      return true;
    });
    if (resumed) this.kick();
  }

  // --- Startup -------------------------------------------------------------------------------------------------------

  async recover(): Promise<void> {
    await this.reconcile();
  }

  async openRequests(taskId: string): Promise<OwnerRequest[]> {
    const rows = await many<OwnerRequestRow>(this.db, "select * from owner_requests where task_id = $1 and answered_at is null order by created_at", [taskId]);
    return rows.map(ownerRequestView);
  }

  stop(): void {
    this.stopped = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

// What the owner decided on site requests, in the words the agent gets.
export function siteDecisionText(rows: { domains: string[]; decision: string | null; attended: boolean }[]): string {
  const sites = (pick: (row: { decision: string | null; attended: boolean }) => boolean) =>
    rows.filter(pick).flatMap((row) => row.domains.map(siteLabel)).join(", ");
  const allowed = sites((row) => row.decision !== "refuse" && !row.attended);
  const attended = sites((row) => row.decision !== "refuse" && row.attended);
  const refused = sites((row) => row.decision === "refuse");
  return [
    allowed && `Allowed: ${allowed}, each with all its subdomains.`,
    attended && `Allowed only during an attended session: ${attended}, each with all its subdomains.`,
    refused && `The owner refused ${refused}. Find another way or tell the owner what you cannot do.`,
  ].filter(Boolean).join(" ");
}
