import type { AuditActor, AuditEvent, AuditType } from "@quokkabot/shared";
import { AUDIT_GENESIS_HASH } from "@quokkabot/shared";
import { auditHash, hmacHex, verifyAuditChain } from "@quokkabot/shared/node";
import { type Db, type Tx, many, maybeOne, withTx } from "./db.js";

// Hash-chained, append-only log per agent. Appends for one agent are serialised in this process; the database
// function re-checks the sequence and the previous hash, and the application role cannot update or delete rows.
export class AuditLog {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly hmacKey: Buffer,
  ) {}

  // Typed text is recorded as a keyed hash so the log can show that two values were equal without storing them.
  textDigest(text: string): { hmac: string; length: number } {
    return { hmac: hmacHex(this.hmacKey, text), length: text.length };
  }

  append(agentId: string, actor: AuditActor, type: AuditType, data: Record<string, unknown>, tx?: Tx): Promise<AuditEvent> {
    if (tx) return this.appendNow(agentId, actor, type, data, tx);
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => withTx(this.db, (client) => this.appendNow(agentId, actor, type, data, client)));
    this.queues.set(agentId, next);
    return next;
  }

  private async appendNow(
    agentId: string,
    actor: AuditActor,
    type: AuditType,
    data: Record<string, unknown>,
    tx: Tx,
  ): Promise<AuditEvent> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 1))", [agentId]);
    const head = await maybeOne<{ seq: number; hash: string }>(
      tx,
      "select seq, hash from audit_heads where agent_id = $1",
      [agentId],
    );
    const base = {
      agentId: agentId as AuditEvent["agentId"],
      seq: (head?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      actor,
      type,
      // Round-trip through JSON so the stored jsonb and the hashed value are identical.
      data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
      prevHash: head?.hash ?? AUDIT_GENESIS_HASH,
    };
    const hash = auditHash(base);
    await tx.query("select audit_append($1, $2, $3, $4, $5, $6, $7, $8)", [
      base.agentId,
      base.seq,
      base.at,
      base.actor,
      base.type,
      JSON.stringify(base.data),
      base.prevHash,
      hash,
    ]);
    return { ...base, hash };
  }

  async page(agentId: string, beforeSeq: number | null, limit = 100): Promise<AuditEvent[]> {
    // The sequence boundary also separates two occupants added within the same timestamp millisecond.
    const rows = await many<AuditRow>(
      this.db,
      `select agent_id, seq, at, actor, type, data, prev_hash, hash from audit_events
       where agent_id = $1 and at >= (select added_at from agents where id = $1)
         and seq >= coalesce((select max(seq) from audit_events where agent_id = $1 and type = 'agent.added'), 0)
         and ($2::bigint is null or seq < $2) order by seq desc limit $3`,
      [agentId, beforeSeq, limit],
    );
    return rows.map(rowToEvent);
  }

  async head(agentId: string): Promise<{ seq: number; hash: string }> {
    const head = await maybeOne<{ seq: number; hash: string }>(
      this.db,
      "select seq, hash from audit_heads where agent_id = $1",
      [agentId],
    );
    return head ?? { seq: 0, hash: AUDIT_GENESIS_HASH };
  }

  async verify(agentId: string): Promise<ReturnType<typeof verifyAuditChain>> {
    const rows = await many<AuditRow>(
      this.db,
      "select agent_id, seq, at, actor, type, data, prev_hash, hash from audit_events where agent_id = $1 order by seq",
      [agentId],
    );
    const head = await this.head(agentId);
    return verifyAuditChain(rows.map(rowToEvent), head.seq === 0 ? undefined : head.hash);
  }
}

interface AuditRow {
  agent_id: string;
  seq: number;
  at: Date;
  actor: string;
  type: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  [key: string]: unknown;
}

function rowToEvent(row: AuditRow): AuditEvent {
  return {
    agentId: row.agent_id as AuditEvent["agentId"],
    seq: row.seq,
    // The hash covers the ISO string that was written; timestamptz round-trips it exactly to the millisecond.
    at: row.at.toISOString(),
    actor: row.actor as AuditActor,
    type: row.type as AuditType,
    data: row.data,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}
