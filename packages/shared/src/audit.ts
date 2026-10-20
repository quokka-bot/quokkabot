import { z } from "zod";
import { AgentId } from "./primitives.js";

export const AuditActor = z.enum(["owner", "agent", "system"]);
export type AuditActor = z.infer<typeof AuditActor>;

export const AuditType = z.enum([
  "owner.setup_link_created",
  "owner.pairing_code_created",
  "owner.pairing_codes_revoked",
  "owner.passkey_registered",
  "owner.signed_in",
  "owner.signed_out",
  "owner.filled_field",
  "claude.signed_in",
  "owner.fresh_auth",
  "agent.created",
  "agent.added",
  "agent.removed",
  "agent.settings_changed",
  "ai_consent.granted",
  "ai_consent.withdrawn",
  "computer.started",
  "computer.stopped",
  "kill.engaged",
  "kill.released",
  "task.created",
  "task.state_changed",
  "message.reaction_changed",
  "run.started",
  "run.exited",
  "tool.called",
  "tool.result",
  "browser.command",
  "browser.result",
  "download.completed",
  "file.published",
  "attachment.added",
  "file.written",
  "exec.ran",
  "domain.requested",
  "domain.decided",
  "domain.rule_added",
  "domain.rule_removed",
  "egress.blocked_summary",
  "takeover.started",
  "takeover.ended",
  "takeover.screen",
  "attended.opened",
  "attended.closed",
  "terminal.opened",
  "terminal.closed",
  "owner_request.created",
  "owner_request.answered",
  "login.added",
  "login.changed",
  "login.removed",
  "login.used",
  "connector.added",
  "connector.removed",
  "connector.used",
]);
export type AuditType = z.infer<typeof AuditType>;

export const AuditEvent = z.object({
  agentId: AgentId,
  seq: z.number().int().min(1),
  at: z.string(),
  actor: AuditActor,
  type: AuditType,
  // Never raw secrets: typed text is stored as an HMAC, terminal content is never recorded.
  data: z.record(z.string(), z.unknown()),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

// Hash of "nothing before": the first event of every agent chains to it.
export const AUDIT_GENESIS_HASH = "0".repeat(64);

// Canonical JSON: object keys sorted, no whitespace, no undefined. Numbers must be finite.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

// The bytes that are hashed for one event: the previous hash, a newline, then the canonical JSON of every field
// except `hash` itself.
export function auditHashInput(event: Omit<AuditEvent, "hash">): string {
  const { prevHash, ...rest } = event;
  return `${prevHash}\n${canonicalJson(rest)}`;
}
