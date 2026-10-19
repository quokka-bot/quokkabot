import { randomBytes, randomUUID } from "node:crypto";
import { hmacHex, safeEqual, sha256Hex } from "@quokkabot/shared/node";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuditLog } from "./audit.js";
import type { ControlConfig } from "./config.js";
import { type Db, maybeOne, many, one, withTx } from "./db.js";
import { HttpError } from "./errors.js";

export const SESSION_COOKIE = "qb_session";
export const VIEW_COOKIE = "qb_view";
// Carries the id of the pending WebAuthn challenge between the options and verify calls.
export const CHALLENGE_COOKIE = "qb_challenge";
// A signed, database-free capability for the kill switch only: stopping the agent must work while PostgreSQL is down.
export const KILL_COOKIE = "qb_kill";
const SESSION_DAYS = 30;
// A phone session stays signed in while it is used: it expires 30 days after its last use, and 180 days after it was
// created at the latest, so a copied token cannot be kept alive forever.
const PHONE_IDLE_DAYS = 30;
export const PHONE_MAX_DAYS = 180;
const FRESH_MINUTES = 5;
const CHALLENGE_MINUTES = 5;
const SETUP_TICKET_MINUTES = 30;
const VIEW_TICKET_SECONDS = 60;
const VIEW_SESSION_HOURS = 12;

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

// Which app a session belongs to. Browser and desktop sessions travel in the session cookie, phone sessions in an
// Authorization header, and each is accepted only the way it travels.
export type SessionClient = "browser" | "desktop" | "phone";
export type SessionTransport = "cookie" | "bearer";

export interface SessionInfo {
  hash: string;
  freshUntil: Date | null;
  client: SessionClient;
}

export class Auth {
  private readonly rpId: string;

  constructor(
    private readonly db: Db,
    private readonly config: ControlConfig,
    private readonly audit: AuditLog,
    private readonly auditAgentIds: () => string[] | Promise<string[]>,
  ) {
    this.rpId = new URL(config.appOrigin).hostname;
  }

  // Printed by the installer. The ticket rides in the URL fragment, so it never reaches a server log.
  async createSetupLink(): Promise<string> {
    const ticket = newSecret();
    await this.db.query("insert into setup_tickets (hash, expires_at) values ($1, now() + $2::interval)", [
      sha256Hex(ticket),
      `${SETUP_TICKET_MINUTES} minutes`,
    ]);
    for (const agentId of await this.auditAgentIds()) {
      await this.audit.append(agentId, "system", "owner.setup_link_created", { expiresInMinutes: SETUP_TICKET_MINUTES });
    }
    return `${this.config.appOrigin}/setup#${ticket}`;
  }

  private async requireTicket(ticket: string): Promise<string> {
    const hash = sha256Hex(ticket);
    const row = await maybeOne<{ hash: string }>(
      this.db,
      "select hash from setup_tickets where hash = $1 and used_at is null and expires_at > now()",
      [hash],
    );
    if (!row) throw new HttpError(403, "setup_link_invalid", "This setup link is used or expired. Create a new one on the server.");
    return hash;
  }

  private async webauthnUserId(): Promise<string> {
    const existing = await maybeOne<{ webauthn_user_id: string }>(this.db, "select webauthn_user_id from owner_account where id = 1");
    return existing?.webauthn_user_id ?? randomBytes(32).toString("base64url");
  }

  async setupOptions(ticket: string): Promise<{ challengeId: string; options: unknown }> {
    const ticketHash = await this.requireTicket(ticket);
    const userId = await this.webauthnUserId();
    const existing = await many<{ id: string; transports: string[] }>(this.db, "select id, transports from passkeys");
    const options = await generateRegistrationOptions({
      rpName: "Quokka Bot",
      rpID: this.rpId,
      userName: this.config.ownerName,
      userID: Buffer.from(userId, "base64url"),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as never })),
    });
    const challengeId = randomUUID();
    await this.db.query(
      "insert into webauthn_challenges (id, challenge, purpose, ticket_hash, expires_at) values ($1, $2, 'setup', $3, now() + $4::interval)",
      [challengeId, options.challenge, ticketHash, `${CHALLENGE_MINUTES} minutes`],
    );
    return { challengeId, options };
  }

  async setupVerify(ticket: string, challengeId: string, response: unknown): Promise<string> {
    const ticketHash = await this.requireTicket(ticket);
    const challenge = await this.takeChallenge(challengeId, "setup");
    if (challenge.ticket_hash !== ticketHash) throw new HttpError(403, "challenge_mismatch", "Start the setup again.");
    const verification = await verifyRegistrationResponse({
      response: response as never,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.config.appOrigin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
    });
    if (!verification.verified) throw new HttpError(403, "passkey_not_verified", "The passkey could not be verified.");
    const credential = verification.registrationInfo.credential;
    const userId = await this.webauthnUserId();
    const sessionToken = newSecret();
    await withTx(this.db, async (tx) => {
      const used = await tx.query("update setup_tickets set used_at = now() where hash = $1 and used_at is null", [ticketHash]);
      if (used.rowCount !== 1) throw new HttpError(403, "setup_link_invalid", "This setup link was already used.");
      await tx.query(
        "insert into owner_account (id, name, webauthn_user_id) values (1, $1, $2) on conflict (id) do nothing",
        [this.config.ownerName, userId],
      );
      await tx.query("insert into passkeys (id, public_key, counter, transports) values ($1, $2, $3, $4)", [
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        credential.transports ?? [],
      ]);
      await tx.query(
        "insert into sessions (hash, expires_at, fresh_until) values ($1, now() + $2::interval, now() + $3::interval)",
        [sha256Hex(sessionToken), `${SESSION_DAYS} days`, `${FRESH_MINUTES} minutes`],
      );
    });
    for (const agentId of await this.auditAgentIds()) {
      await this.audit.append(agentId, "owner", "owner.passkey_registered", { credentialId: credential.id.slice(0, 12) });
    }
    return sessionToken;
  }

  async signinOptions(purpose: "signin" | "fresh" | "link", sessionHash: string | null, linkId: string | null = null): Promise<{ challengeId: string; options: unknown }> {
    const passkeys = await many<{ id: string; transports: string[] }>(this.db, "select id, transports from passkeys");
    if (passkeys.length === 0) throw new HttpError(409, "not_set_up", "No passkey is registered yet. Use the setup link from the server.");
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      userVerification: "required",
      allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports as never })),
    });
    const challengeId = randomUUID();
    await this.db.query(
      "insert into webauthn_challenges (id, challenge, purpose, session_hash, link_id, expires_at) values ($1, $2, $3, $4, $5, now() + $6::interval)",
      [challengeId, options.challenge, purpose, sessionHash, linkId, `${CHALLENGE_MINUTES} minutes`],
    );
    return { challengeId, options };
  }

  // Returns a new session token for "signin"; for "fresh" it marks the existing session fresh.
  async signinVerify(
    purpose: "signin" | "fresh" | "link",
    challengeId: string,
    response: unknown,
    sessionHash: string | null,
    linkId: string | null = null,
  ): Promise<string | null> {
    const challenge = await this.takeChallenge(challengeId, purpose);
    if ((purpose === "fresh" || purpose === "link") && challenge.session_hash !== sessionHash) {
      throw new HttpError(403, "challenge_mismatch", "Start again.");
    }
    if (purpose === "link" && challenge.link_id !== linkId) throw new HttpError(403, "challenge_mismatch", "Start again.");
    const credentialId = typeof response === "object" && response !== null ? (response as { id?: unknown }).id : null;
    if (typeof credentialId !== "string") throw new HttpError(400, "invalid_response", "Missing credential id.");
    const passkey = await maybeOne<{ id: string; public_key: Buffer; counter: number; transports: string[] }>(
      this.db,
      "select id, public_key, counter, transports from passkeys where id = $1",
      [credentialId],
    );
    if (!passkey) throw new HttpError(403, "unknown_passkey", "This passkey is not registered here.");
    const verification = await verifyAuthenticationResponse({
      response: response as never,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.config.appOrigin,
      expectedRPID: this.rpId,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.counter,
        transports: passkey.transports as never,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) throw new HttpError(403, "passkey_not_verified", "The passkey could not be verified.");
    await this.db.query("update passkeys set counter = $2, last_used_at = now() where id = $1", [
      passkey.id,
      verification.authenticationInfo.newCounter,
    ]);
    // A link assertion approves that one link; the caller records it. It does not make the browser session fresh.
    if (purpose === "link") return null;
    if (purpose === "fresh") {
      await this.db.query("update sessions set fresh_until = now() + $2::interval where hash = $1", [sessionHash, `${FRESH_MINUTES} minutes`]);
      for (const agentId of await this.auditAgentIds()) await this.audit.append(agentId, "owner", "owner.fresh_auth", {});
      return null;
    }
    const token = newSecret();
    await this.db.query(
      "insert into sessions (hash, expires_at, fresh_until) values ($1, now() + $2::interval, now() + $3::interval)",
      [sha256Hex(token), `${SESSION_DAYS} days`, `${FRESH_MINUTES} minutes`],
    );
    for (const agentId of await this.auditAgentIds()) await this.audit.append(agentId, "owner", "owner.signed_in", {});
    return token;
  }

  private async takeChallenge(
    id: string,
    purpose: "setup" | "signin" | "fresh" | "link",
  ): Promise<{ challenge: string; ticket_hash: string | null; session_hash: string | null; link_id: string | null }> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "invalid_challenge", "Start again.");
    const row = await maybeOne<{ challenge: string; ticket_hash: string | null; session_hash: string | null; link_id: string | null }>(
      this.db,
      "delete from webauthn_challenges where id = $1 and purpose = $2 and expires_at > now() returning challenge, ticket_hash, session_hash, link_id",
      [id, purpose],
    );
    if (!row) throw new HttpError(403, "challenge_expired", "That took too long. Start again.");
    return row;
  }

  async session(token: string | undefined, transport: SessionTransport): Promise<SessionInfo | null> {
    if (!token || token.length > 100) return null;
    const hash = sha256Hex(token);
    // Also records when the device was last seen (at most every five minutes), for the signed-in devices list, and
    // moves a phone session's expiry to 30 days from now on every use, never past its absolute end.
    const row = await maybeOne<{ hash: string; fresh_until: Date | null; client: SessionClient }>(
      this.db,
      `update sessions set
         last_seen_at = case when last_seen_at is null or last_seen_at < now() - interval '5 minutes' then now() else last_seen_at end,
         expires_at = case when client = 'phone' then least(absolute_expires_at, now() + $3::interval) else expires_at end
       where hash = $1 and expires_at > now() and revoked_at is null and (client = 'phone') = $2
       returning hash, fresh_until, client`,
      [hash, transport === "bearer", `${PHONE_IDLE_DAYS} days`],
    );
    // A phone session never counts as a fresh passkey check, whatever its row says.
    return row ? { hash: row.hash, freshUntil: row.client === "phone" ? null : row.fresh_until, client: row.client } : null;
  }

  async devices(currentHash: string): Promise<{ id: string; deviceName: string; client: SessionClient; createdAt: string; lastSeenAt: string | null; current: boolean }[]> {
    const rows = await many<{ hash: string; device_name: string; client: SessionClient; created_at: Date; last_seen_at: Date | null }>(
      this.db,
      "select hash, device_name, client, created_at, last_seen_at from sessions where expires_at > now() and revoked_at is null order by coalesce(last_seen_at, created_at) desc",
    );
    return rows.map((r) => ({
      id: r.hash.slice(0, 16),
      deviceName: r.device_name,
      client: r.client,
      createdAt: r.created_at.toISOString(),
      lastSeenAt: r.last_seen_at?.toISOString() ?? null,
      current: r.hash === currentHash,
    }));
  }

  // Revokes a device by its public id (the first 16 hex characters of the session hash); returns the full hash.
  async revokeDevice(id: string): Promise<string | null> {
    if (!/^[0-9a-f]{16}$/.test(id)) return null;
    const row = await maybeOne<{ hash: string }>(
      this.db,
      "update sessions set revoked_at = now() where left(hash, 16) = $1 and revoked_at is null returning hash",
      [id],
    );
    return row?.hash ?? null;
  }

  async signOut(hash: string): Promise<void> {
    await this.db.query("update sessions set revoked_at = now() where hash = $1", [hash]);
  }

  async revokeAllSessions(): Promise<void> {
    await this.db.query("update sessions set revoked_at = now() where revoked_at is null");
    await this.db.query("delete from view_sessions");
  }

  async passkeyCount(): Promise<number> {
    const row = await one<{ n: number }>(this.db, "select count(*)::int as n from passkeys");
    return row.n;
  }

  // --- Viewer origin capability --------------------------------------------------------------------------------

  async createViewTicket(agentId: string, sessionHash: string): Promise<string> {
    await this.requireAgent(agentId);
    const ticket = newSecret();
    await this.db.query(
      "insert into view_tickets (hash, agent_id, session_hash, expires_at) values ($1, $2, $3, now() + $4::interval)",
      [sha256Hex(ticket), agentId, sessionHash, `${VIEW_TICKET_SECONDS} seconds`],
    );
    return ticket;
  }

  // Exchanges a one-time ticket for a viewer cookie valid only on the viewer origin and only for one agent.
  async redeemViewTicket(ticket: string, agentId: string): Promise<string> {
    await this.requireAgent(agentId);
    const hash = sha256Hex(ticket);
    const row = await maybeOne<{ session_hash: string }>(
      this.db,
      `update view_tickets set used_at = now()
       where hash = $1 and agent_id = $2 and used_at is null and expires_at > now()
       returning session_hash`,
      [hash, agentId],
    );
    if (!row) throw new HttpError(403, "view_ticket_invalid", "Open the computer again from the app.");
    const sessionAlive = await maybeOne(
      this.db,
      "select 1 from sessions where hash = $1 and expires_at > now() and revoked_at is null",
      [row.session_hash],
    );
    if (!sessionAlive) throw new HttpError(403, "signed_out", "Sign in again.");
    const token = newSecret();
    await this.db.query(
      "insert into view_sessions (hash, agent_id, session_hash, expires_at) values ($1, $2, $3, now() + $4::interval)",
      [sha256Hex(token), agentId, row.session_hash, `${VIEW_SESSION_HOURS} hours`],
    );
    return token;
  }

  // The owner session behind a viewer cookie, or null.
  async viewSession(token: string | undefined, agentId: string): Promise<string | null> {
    await this.requireAgent(agentId);
    if (!token || token.length > 100) return null;
    const row = await maybeOne<{ session_hash: string }>(
      this.db,
      `select v.session_hash from view_sessions v join sessions s on s.hash = v.session_hash
       where v.hash = $1 and v.agent_id = $2 and v.expires_at > now() and s.expires_at > now() and s.revoked_at is null`,
      [sha256Hex(token), agentId],
    );
    return row?.session_hash ?? null;
  }

  // Whether a viewer cookie still holds: an open viewer socket ends when its 12 hours are up, like a new one would.
  async viewSessionAlive(token: string, agentId: string): Promise<boolean> {
    return (await this.viewSession(token, agentId)) !== null;
  }

  async sessionAlive(hash: string): Promise<boolean> {
    const row = await maybeOne(this.db, "select 1 from sessions where hash = $1 and expires_at > now() and revoked_at is null", [hash]);
    return row !== null;
  }

  private async requireAgent(agentId: string): Promise<void> {
    if (!(await this.auditAgentIds()).includes(agentId)) throw new HttpError(404, "unknown_agent", "No such agent.");
  }
}

export function killCapability(secret: Buffer, days: number): string {
  const expires = Math.floor(Date.now() / 1000) + days * 24 * 3600;
  return `${expires}.${hmacHex(secret, `kill:${expires}`)}`;
}

export function killCapabilityValid(secret: Buffer, value: string | undefined): boolean {
  if (!value || value.length > 120) return false;
  const [expires, mac] = value.split(".");
  if (!expires || !mac || !/^[0-9]{10}$/.test(expires) || Number(expires) * 1000 < Date.now()) return false;
  return safeEqual(mac, hmacHex(secret, `kill:${expires}`));
}

export function isFresh(session: SessionInfo): boolean {
  return session.freshUntil !== null && session.freshUntil.getTime() > Date.now();
}
