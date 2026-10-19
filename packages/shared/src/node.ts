// Node-only helpers (they use node:crypto). Import from "@quokkabot/shared/node"; never from the web app.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AUDIT_GENESIS_HASH, type AuditEvent, auditHashInput } from "./audit.js";

export { registrableDomain, sitePattern, sitePatterns } from "./sites.js";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(key: Uint8Array, input: string): string {
  return createHmac("sha256", key).update(input).digest("hex");
}

export function auditHash(event: Omit<AuditEvent, "hash">): string {
  return sha256Hex(auditHashInput(event));
}

export type AuditVerification =
  | { ok: true; count: number; head: string }
  | { ok: false; count: number; failedAtSeq: number; reason: string };

// Verifies one agent's chain in sequence order. Detects edits, deletions, insertions and reordering.
export function verifyAuditChain(events: readonly AuditEvent[], expectedHead?: string): AuditVerification {
  let prev = AUDIT_GENESIS_HASH;
  let expectedSeq = 1;
  for (const event of events) {
    if (event.seq !== expectedSeq) {
      return { ok: false, count: expectedSeq - 1, failedAtSeq: event.seq, reason: `expected seq ${expectedSeq}` };
    }
    if (event.prevHash !== prev) {
      return { ok: false, count: expectedSeq - 1, failedAtSeq: event.seq, reason: "prevHash does not match" };
    }
    const { hash, ...rest } = event;
    if (auditHash(rest) !== hash) {
      return { ok: false, count: expectedSeq - 1, failedAtSeq: event.seq, reason: "hash does not match content" };
    }
    prev = hash;
    expectedSeq += 1;
  }
  if (expectedHead !== undefined && expectedHead !== prev) {
    return { ok: false, count: expectedSeq - 1, failedAtSeq: expectedSeq - 1, reason: "head differs from checkpoint" };
  }
  return { ok: true, count: expectedSeq - 1, head: prev };
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
