import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ConnectorView } from "@quokkabot/shared";
import type { Logger } from "pino";
import type { AgentSlots } from "./agents.js";
import type { AuditLog } from "./audit.js";
import { type Db, many, maybeOne, one, withTx } from "./db.js";
import { HttpError } from "./errors.js";
import { decryptValue, encryptValue } from "./vault.js";

// Connected apps. The owner approves an app (Gmail) on the provider's own page; Quokka Bot keeps the refresh token
// encrypted with the vault key and calls the provider's API for the agent. The agent never sees a token or a password.

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];
const STATE_MINUTES = 15;
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

interface ConnectorRow {
  id: string;
  agent_id: string;
  app: "gmail";
  account: string;
  refresh_enc: Buffer;
  created_at: Date;
}

interface ConnectedAccount { agentId: string; account: string; id: string }

function view(row: ConnectorRow): ConnectorView {
  return { id: row.id, agentId: row.agent_id as ConnectorView["agentId"], app: row.app, account: row.account, connectedAt: row.created_at.toISOString() };
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

// An email header value: plain ASCII as is, anything else as RFC 2047 encoded UTF-8.
function headerValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  // 39 UTF-8 bytes leave room for the encoding and Subject prefix within RFC 2047's 76-character lines.
  // Keep UTF-8 code points intact when folding so each encoded word decodes on its own.
  const words: string[] = [];
  let chunk = "";
  for (const char of clean) {
    if (Buffer.byteLength(chunk + char, "utf8") > 39) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  return words.join("\r\n ");
}

interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] }

function partText(part: GmailPart | undefined, type: string): string | null {
  if (!part) return null;
  if (part.mimeType === type && part.body?.data !== undefined) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const child of part.parts ?? []) {
    const found = partText(child, type);
    if (found !== null) return found;
  }
  return null;
}

export class Connectors {
  private readonly tokens = new Map<string, { token: string; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    private readonly audit: AuditLog,
    private readonly appOrigin: string,
    private readonly google: GoogleClient | null,
    private readonly slots: AgentSlots,
    private readonly log: Pick<Logger, "warn">,
  ) {}

  available(): { gmail: boolean } {
    return { gmail: this.google !== null };
  }

  async removeAgent(agentId: string): Promise<void> {
    const rows = await many<ConnectorRow>(this.db, "select * from connectors where agent_id = $1 order by id", [agentId]);
    for (const row of rows) {
      // Persist each confirmed revoke so a later failure never requires revoking that token twice.
      const revoked = await maybeOne(this.db, "select 1 from kv where key = $1", [`connector_revoked:${row.id}`]);
      if (!revoked) {
        await this.revoke(row);
        this.tokens.delete(row.id);
        await this.db.query("insert into kv (key, value) values ($1, 'true'::jsonb) on conflict (key) do nothing", [`connector_revoked:${row.id}`]);
      }
    }
    await withTx(this.db, async (tx) => {
      await tx.query("delete from connectors where agent_id = $1", [agentId]);
      for (const row of rows) await tx.query("delete from kv where key = $1", [`connector_revoked:${row.id}`]);
    });
  }

  redirectUri(): string {
    return `${this.appOrigin}/api/connect/google/callback`;
  }

  async list(agentId: string): Promise<ConnectorView[]> {
    await this.slots.require(agentId, false);
    return (await many<ConnectorRow>(this.db, "select * from connectors where agent_id = $1 order by created_at", [agentId])).map(view);
  }

  async gmailAccount(agentId: string): Promise<string | null> {
    await this.slots.require(agentId, false);
    const row = await maybeOne<{ account: string }>(this.db, "select account from connectors where agent_id = $1 and app = 'gmail' order by created_at desc limit 1", [agentId]);
    return row?.account ?? null;
  }

  // The URL that sends the owner's browser to Google's consent page. The state is single use and expires.
  async start(agentId: string): Promise<string> {
    const slot = await this.slots.require(agentId, false);
    const google = this.requireGoogle();
    const state = randomBytes(24).toString("base64url");
    await this.db.query("insert into connect_states (state_hash, agent_id, app, generation) values ($1, $2, 'gmail', $3)", [hashState(state), agentId, slot.generation]);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", google.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    // Always ask, so Google returns a refresh token even when the account approved Quokka Bot before.
    url.searchParams.set("prompt", "consent select_account");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", state);
    return url.href;
  }

  // Google's redirect back: checks the state, exchanges the code and stores the account's refresh token.
  async callback(code: string, state: string, onConnected?: (account: ConnectedAccount) => Promise<void>): Promise<ConnectedAccount> {
    const google = this.requireGoogle();
    const used = await maybeOne<{ agent_id: string; generation: number | null }>(
      this.db,
      `update connect_states set used_at = now() where state_hash = $1 and used_at is null
         and created_at > now() - $2::interval returning agent_id, generation`,
      [hashState(state), `${STATE_MINUTES} minutes`],
    );
    if (!used || used.generation === null) throw new HttpError(400, "invalid_state", "This connection link expired or was already used. Start again in Quokka Bot.");
    const generation = used.generation;
    const token = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri(), client_id: google.clientId, client_secret: google.clientSecret });
    const refresh = token.refresh_token;
    if (typeof refresh !== "string" || refresh.length === 0) throw new HttpError(502, "no_refresh_token", "Google did not return a refresh token. Start again in Quokka Bot.");
    return this.slots.exclusive(used.agent_id, async () => {
      try {
        await this.slots.require(used.agent_id, false, generation);
      } catch (error) {
        if (!(error instanceof HttpError) || !["unknown_agent", "agent_replaced", "agent_removing"].includes(error.code)) throw error;
        try { await this.revokeRefresh(refresh); }
        catch {
          // Provider errors can contain tokens. Log only the slot and the failed action.
          this.log.warn({ agentId: used.agent_id }, "revoking Gmail access for a removed agent failed");
        }
        throw new HttpError(409, "agent_replaced", "This agent was removed before Gmail finished connecting.");
      }
      const granted = String(token.scope ?? "").split(" ");
      for (const scope of GOOGLE_SCOPES.slice(2)) {
        if (!granted.includes(scope)) throw new HttpError(400, "scope_missing", "Gmail access was not granted. Start again and tick every Gmail permission.");
      }
      const account = this.emailFromIdToken(String(token.id_token ?? ""));
      const id = randomUUID();
      const replaced = await withTx(this.db, async (tx) => {
        // Serialise switches and disconnects, including two consent callbacks for the same agent.
        await one(tx, "select id from agents where id = $1 for update", [used.agent_id]);
        const previous = await many<ConnectorRow>(tx, "select * from connectors where agent_id = $1 and app = 'gmail'", [used.agent_id]);
        await tx.query(
          `insert into connectors (id, agent_id, app, account, refresh_enc) values ($1, $2, 'gmail', $3, $4)
           on conflict (agent_id, app, account) do update set id = excluded.id, refresh_enc = excluded.refresh_enc, created_at = now()`,
          [id, used.agent_id, account, encryptValue(this.key, `${used.agent_id}:gmail:${account}`, "refresh", refresh)],
        );
        for (const old of previous) {
          // Revoking the same account would also revoke its newly granted access.
          if (old.account === account) continue;
          await this.revoke(old);
          await tx.query("delete from connectors where id = $1", [old.id]);
        }
        return previous;
      });
      for (const old of replaced) this.tokens.delete(old.id);
      for (const old of replaced.filter((old) => old.account !== account)) {
        await this.audit.append(used.agent_id, "owner", "connector.removed", { app: old.app, account: old.account });
      }
      await this.audit.append(used.agent_id, "owner", "connector.added", { app: "gmail", account });
      const connected = { agentId: used.agent_id, account, id };
      // Resuming a waiting chat belongs to the same occupant as the stored connection.
      await onConnected?.(connected);
      return connected;
    });
  }

  async remove(connectorId: string): Promise<void> {
    const found = await maybeOne<ConnectorRow>(this.db, "select * from connectors where id = $1", [connectorId]);
    if (!found) throw new HttpError(404, "unknown_connector", "No such connection.");
    await this.slots.require(found.agent_id, false);
    const row = await withTx(this.db, async (tx) => {
      await one(tx, "select id from agents where id = $1 for update", [found.agent_id]);
      const current = await maybeOne<ConnectorRow>(tx, "select * from connectors where id = $1", [connectorId]);
      if (!current) throw new HttpError(404, "unknown_connector", "No such connection.");
      await this.revoke(current);
      await tx.query("delete from connectors where id = $1", [connectorId]);
      return current;
    });
    this.tokens.delete(row.id);
    await this.audit.append(row.agent_id, "owner", "connector.removed", { app: row.app, account: row.account });
  }

  // --- Gmail for the agent -------------------------------------------------------------------------------------------

  async gmailSearch(agentId: string, query: string, max: number): Promise<string> {
    const list = await this.gmail(agentId, `/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`) as { messages?: { id: string }[] };
    const ids = list.messages ?? [];
    if (ids.length === 0) return "No messages match.";
    const lines: string[] = [];
    for (const { id } of ids) {
      const message = await this.gmail(agentId, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`) as { id: string; snippet?: string; payload?: GmailPart };
      const header = (name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
      lines.push(`${message.id}  ${header("Date")}\n  From: ${header("From")}\n  Subject: ${header("Subject")}\n  ${message.snippet ?? ""}`);
    }
    await this.audit.append(agentId, "agent", "connector.used", { app: "gmail", op: "search", results: ids.length });
    return lines.join("\n");
  }

  async gmailRead(agentId: string, messageId: string): Promise<string> {
    const message = await this.gmail(agentId, `/messages/${messageId}?format=full`) as { id: string; payload?: GmailPart };
    const header = (name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
    const plain = partText(message.payload, "text/plain");
    const html = plain === null ? partText(message.payload, "text/html") : null;
    const body = plain ?? (html ?? "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
    await this.audit.append(agentId, "agent", "connector.used", { app: "gmail", op: "read", messageId });
    return `From: ${header("From")}\nTo: ${header("To")}\nDate: ${header("Date")}\nSubject: ${header("Subject")}\n\n${body}`;
  }

  async gmailCreateDraft(agentId: string, input: { to: string[]; cc: string[]; subject: string; body: string }): Promise<string> {
    const lines = [
      `To: ${input.to.join(", ")}`,
      ...(input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
      `Subject: ${headerValue(input.subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(input.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    ];
    const raw = Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
    const draft = await this.gmail(agentId, "/drafts", { message: { raw } }) as { id: string; message?: { id: string } };
    await this.audit.append(agentId, "agent", "connector.used", { app: "gmail", op: "create_draft", draftId: draft.id, to: this.audit.textDigest(JSON.stringify(input.to)) });
    return draft.id;
  }

  // --- Plumbing ------------------------------------------------------------------------------------------------------

  private async revoke(row: ConnectorRow): Promise<void> {
    const refresh = decryptValue(this.key, `${row.agent_id}:gmail:${row.account}`, "refresh", row.refresh_enc);
    await this.revokeRefresh(refresh);
  }

  private async revokeRefresh(refresh: string): Promise<void> {
    try {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refresh }), signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return;
    } catch {
      // An unconfirmed revoke must leave the stored connection available for an owner retry.
    }
    throw new HttpError(502, "google_revoke", "Google did not confirm the disconnect; try again");
  }

  private requireGoogle(): GoogleClient {
    if (!this.google) throw new HttpError(409, "not_configured", "This server has no Google connection set up.");
    return this.google;
  }

  private emailFromIdToken(idToken: string): string {
    // Received straight from Google's token endpoint over TLS, so the payload is Google's own statement.
    const payload = idToken.split(".")[1];
    if (!payload) throw new HttpError(502, "no_identity", "Google did not say which account was connected.");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string; email_verified?: boolean };
    if (!claims.email || claims.email_verified === false) throw new HttpError(502, "no_identity", "Google did not return a verified email address.");
    return claims.email.toLowerCase();
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new HttpError(502, "google_token", `Google refused the request: ${String(body.error_description ?? body.error ?? response.status)}`);
    return body;
  }

  private async accessToken(agentId: string): Promise<{ connectorId: string; token: string }> {
    const google = this.requireGoogle();
    const row = await maybeOne<ConnectorRow>(this.db, "select * from connectors where agent_id = $1 and app = 'gmail' order by created_at desc limit 1", [agentId]);
    if (!row) throw new HttpError(409, "not_connected", "Gmail is not connected. Ask the owner with request_connection.");
    const cached = this.tokens.get(row.id);
    if (cached && cached.expires > Date.now() + 60_000) return { connectorId: row.id, token: cached.token };
    const refresh = decryptValue(this.key, `${row.agent_id}:gmail:${row.account}`, "refresh", row.refresh_enc);
    const token = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refresh, client_id: google.clientId, client_secret: google.clientSecret });
    const access = String(token.access_token ?? "");
    if (!access) throw new HttpError(502, "google_token", "Google did not return an access token.");
    const current = await maybeOne<ConnectorRow>(this.db, "select * from connectors where agent_id = $1 and app = 'gmail' order by created_at desc limit 1", [agentId]);
    if (current?.id !== row.id) throw new HttpError(409, "connection_changed", "Gmail changed while connecting. Try the Gmail tool again.");
    this.tokens.set(row.id, { token: access, expires: Date.now() + Number(token.expires_in ?? 3000) * 1000 });
    return { connectorId: row.id, token: access };
  }

  private async gmail(agentId: string, path: string, body?: unknown): Promise<unknown> {
    const { connectorId, token } = await this.accessToken(agentId);
    const response = await fetch(`${GMAIL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok) {
      if (response.status === 401) this.tokens.delete(connectorId);
      throw new HttpError(502, "gmail_error", `Gmail answered ${response.status}: ${data.error?.message ?? "no details"}`);
    }
    return data;
  }
}
