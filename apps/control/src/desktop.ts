import { randomInt, randomUUID } from "node:crypto";
import type { DesktopLinkPending, DesktopLinkStartResponse } from "@quokkabot/shared";
import { sha256Hex } from "@quokkabot/shared/node";
import type { AuditLog } from "./audit.js";
import { newSecret } from "./auth.js";
import { type Db, maybeOne, one } from "./db.js";
import { HttpError } from "./errors.js";

const LINK_MINUTES = 10;
const MAX_PENDING_LINKS = 20;
const FRESH_MINUTES = 5;
const SESSION_DAYS = 30;
// No 0/O, 1/I/L: the owner compares the code by eye.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function codeHash(userCode: string): string {
  return sha256Hex(`desktop-link:${userCode.toUpperCase()}`);
}

interface LinkRow {
  id: string;
  kind: "signin" | "fresh";
  device_name: string;
  requester_session_hash: string | null;
  created_at: Date;
  expires_at: Date;
  approved_at: Date | null;
  refused_at: Date | null;
  consumed_at: Date | null;
}

export type PollOutcome =
  | { state: "pending" | "refused" | "expired" }
  | { state: "approved"; kind: "fresh" }
  | { state: "approved"; kind: "signin"; sessionToken: string };

// The desktop app's sign-in and fresh re-check through the system browser: the app starts a link and shows its code,
// the owner opens the link in a browser where they are signed in with a passkey, checks the code and approves after a
// fresh passkey check, and the app's poll then receives a session (sign-in) or finds its session fresh (re-check).
export class DesktopLinks {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly appOrigin: string,
    private readonly agentIds: () => string[] | Promise<string[]>,
  ) {}

  async start(kind: "signin" | "fresh", deviceName: string, requesterSessionHash: string | null): Promise<DesktopLinkStartResponse> {
    if (kind === "fresh" && requesterSessionHash === null) throw new HttpError(401, "signed_out", "Sign in first.");
    const pending = await one<{ n: number }>(
      this.db,
      "select count(*)::int as n from desktop_links where expires_at > now() and approved_at is null and refused_at is null",
    );
    if (pending.n >= MAX_PENDING_LINKS) throw new HttpError(429, "too_many_links", "Too many sign-in links are open. Wait ten minutes.");
    const userCode = newUserCode();
    const pollToken = newSecret();
    const row = await one<{ expires_at: Date }>(
      this.db,
      `insert into desktop_links (id, kind, code_hash, poll_hash, device_name, requester_session_hash, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + $7::interval) returning expires_at`,
      [randomUUID(), kind, codeHash(userCode), sha256Hex(pollToken), deviceName, requesterSessionHash, `${LINK_MINUTES} minutes`],
    );
    return { userCode, pollToken, verifyUrl: `${this.appOrigin}/link#${userCode}`, expiresAt: row.expires_at.toISOString() };
  }

  private async open(userCode: string): Promise<LinkRow> {
    const row = await maybeOne<LinkRow>(
      this.db,
      "select * from desktop_links where code_hash = $1 and expires_at > now() and approved_at is null and refused_at is null",
      [codeHash(userCode)],
    );
    if (!row) throw new HttpError(404, "link_not_found", "This code is not open. Start again in the desktop app.");
    return row;
  }

  async pending(userCode: string): Promise<DesktopLinkPending> {
    const row = await this.open(userCode);
    return { kind: row.kind, deviceName: row.device_name, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() };
  }

  // The link's id, for binding a passkey assertion to it.
  async linkId(userCode: string): Promise<string> {
    return (await this.open(userCode)).id;
  }

  // Called only after a passkey assertion bound to this link verified.
  async approve(userCode: string, linkId: string): Promise<void> {
    const row = await this.open(userCode);
    if (row.id !== linkId) throw new HttpError(403, "link_mismatch", "Start again.");
    const approved = await this.db.query("update desktop_links set approved_at = now() where id = $1 and approved_at is null", [row.id]);
    if (approved.rowCount !== 1) throw new HttpError(409, "already_decided", "This code was already decided.");
    if (row.kind === "fresh" && row.requester_session_hash) {
      // The re-check marks only the desktop session that asked for it.
      await this.db.query("update sessions set fresh_until = now() + $2::interval where hash = $1 and revoked_at is null", [
        row.requester_session_hash,
        `${FRESH_MINUTES} minutes`,
      ]);
    }
    for (const agentId of await this.agentIds()) {
      await this.audit.append(agentId, "owner", row.kind === "signin" ? "owner.signed_in" : "owner.fresh_auth", {
        device: row.device_name,
        through: "browser link",
      });
    }
  }

  async refuse(userCode: string): Promise<void> {
    const row = await this.open(userCode);
    await this.db.query("update desktop_links set refused_at = now() where id = $1", [row.id]);
  }

  async poll(pollToken: string): Promise<PollOutcome> {
    const row = await maybeOne<LinkRow>(this.db, "select * from desktop_links where poll_hash = $1", [sha256Hex(pollToken)]);
    if (!row || row.consumed_at) return { state: "expired" };
    if (row.refused_at) return { state: "refused" };
    if (!row.approved_at) return row.expires_at.getTime() > Date.now() ? { state: "pending" } : { state: "expired" };
    // An approval is collected within the link's lifetime or never: an abandoned approved link cannot mint a session later.
    const consumed = await this.db.query("update desktop_links set consumed_at = now() where id = $1 and consumed_at is null and expires_at > now()", [row.id]);
    if (consumed.rowCount !== 1) return { state: "expired" };
    if (row.kind === "fresh") return { state: "approved", kind: "fresh" };
    // The session is created now, at the moment the app collects it; no session secret is ever stored.
    const sessionToken = newSecret();
    await this.db.query(
      "insert into sessions (hash, expires_at, fresh_until, device_name, client) values ($1, now() + $2::interval, now() + $3::interval, $4, 'desktop')",
      [sha256Hex(sessionToken), `${SESSION_DAYS} days`, `${FRESH_MINUTES} minutes`, row.device_name],
    );
    return { state: "approved", kind: "signin", sessionToken };
  }
}
