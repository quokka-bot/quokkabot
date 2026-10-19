import { z } from "zod";
import { Attachment } from "./attachments.js";
import { AgentId, DomainPattern, DomainRequestId, Effort, FileId, ModelId, OwnerRequestId, RunId, Sha256Hex, TaskId } from "./primitives.js";

export const TaskState = z.enum(["queued", "running", "completed", "failed", "outcome_unknown", "cancelled"]);
export type TaskState = z.infer<typeof TaskState>;

// Why a running task is not progressing. Set by the control plane from durable state, never by the model.
export const BlockedReason = z.enum(["waiting_for_owner", "takeover", "domain_request", "attended_session"]);
export type BlockedReason = z.infer<typeof BlockedReason>;

// How a request for sites ended. "skip": the owner wrote a message instead of deciding.
export const DomainDecision = z.enum(["allow_task", "allow_always", "refuse", "skip"]);
export type DomainDecision = z.infer<typeof DomainDecision>;

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "failed",
  "outcome_unknown",
  "cancelled",
]);

export const ResultFile = z.object({
  fileId: FileId,
  name: z.string(),
  bytes: z.number().int().min(0),
  sha256: Sha256Hex,
  scope: z.enum(["downloads", "workspace"]),
});
export type ResultFile = z.infer<typeof ResultFile>;

export const Task = z.object({
  id: TaskId,
  agentId: AgentId,
  title: z.string(),
  state: TaskState,
  blockedReason: BlockedReason.nullable(),
  model: ModelId,
  effort: Effort,
  createdAt: z.string(),
  updatedAt: z.string(),
  // Set once the agent attached evidence and the CLI ended its turn.
  result: z
    .object({ summary: z.string(), files: z.array(ResultFile) })
    .nullable(),
  error: z.string().nullable(),
});
export type Task = z.infer<typeof Task>;

export const RunState = z.enum(["starting", "running", "exited", "lost", "cancelled"]);
export type RunState = z.infer<typeof RunState>;

export const Run = z.object({
  id: RunId,
  taskId: TaskId,
  attempt: z.number().int().min(1),
  state: RunState,
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  // Last time the CLI produced output; the owner's "true status".
  lastEventAt: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

export const OwnerRequest = z.object({
  id: OwnerRequestId,
  taskId: TaskId,
  runId: RunId,
  // "login": the agent needs a login it does not have; `site` and `loginName` say for what.
  // "connect": the agent needs an app connected (Gmail); `connector` names it.
  kind: z.enum(["question", "takeover", "login", "connect"]),
  text: z.string(),
  whatToDo: z.string().nullable(),
  // Fields added after launch default to null so events stored before them still parse.
  site: z.string().nullable().default(null),
  loginName: z.string().nullable().default(null),
  // Set when the agent asks the owner to fix a saved login (a wrong password, a missing 2FA secret).
  loginId: z.uuid().nullable().default(null),
  connector: z.enum(["gmail"]).nullable().default(null),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  answer: z.string().nullable(),
});
export type OwnerRequest = z.infer<typeof OwnerRequest>;

export const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;
export const ReactionEmoji = z.enum(REACTION_EMOJIS);
export type ReactionEmoji = z.infer<typeof ReactionEmoji>;

// Events the owner's app receives for a task, in sequence order. Text from the CLI is untrusted model output and is
// rendered as plain text.
export const TaskEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state"), state: TaskState, blockedReason: BlockedReason.nullable() }),
  z.object({ kind: z.literal("owner_message"), text: z.string(), attachments: z.array(Attachment).default([]) }),
  z.object({ kind: z.literal("assistant_text"), text: z.string() }),
  z.object({ kind: z.literal("assistant_delta"), text: z.string() }),
  z.object({ kind: z.literal("reaction"), targetSeq: z.number().int().min(1), by: z.enum(["owner", "agent"]), emoji: ReactionEmoji.nullable() }),
  z.object({ kind: z.literal("tool_call"), tool: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("tool_result"), tool: z.string(), status: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("owner_request"), request: OwnerRequest }),
  // A request for sites, where the agent asked it, and how the owner decided it.
  z.object({ kind: z.literal("domain_request"), requestId: DomainRequestId, domains: z.array(DomainPattern), reason: z.string() }),
  z.object({ kind: z.literal("domain_decided"), requestId: DomainRequestId, decision: DomainDecision, attended: z.boolean() }),
  z.object({ kind: z.literal("run"), run: Run }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({ kind: z.literal("usage"), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable() }),
]);
export type TaskEvent = z.infer<typeof TaskEvent>;

export const TaskEventEnvelope = z.object({
  taskId: TaskId,
  seq: z.number().int().min(1),
  at: z.string(),
  event: TaskEvent,
});
export type TaskEventEnvelope = z.infer<typeof TaskEventEnvelope>;
