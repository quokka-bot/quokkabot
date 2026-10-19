import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { AgentSlots } from "../src/agents.js";
import type { ControlConfig } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { Connectors } from "../src/connectors.js";
import type { Db } from "../src/db.js";
import { decryptValue, encryptValue } from "../src/vault.js";

const AGENT = "6f1c1d2e-8f4b-4c55-9a59-0d7a7f6f3a10";
const ORIGIN = "https://quokkabot.example.test";
const GOOGLE = { clientId: "fake-client-id", clientSecret: "fake-client-secret" };
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];
const REFRESH = "refresh-token-kept-out-of-the-database";
const KEY = Buffer.alloc(32, 7);
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const hash = (state: string): string => createHash("sha256").update(state).digest("hex");
const encoded = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

interface StateRow {
  state_hash: string;
  agent_id: string;
  generation: number | null;
  app: "gmail";
  created_at: Date;
  used_at: Date | null;
}

interface ConnectorRow {
  id: string;
  agent_id: string;
  app: "gmail";
  account: string;
  refresh_enc: Buffer;
  created_at: Date;
}

interface MessagePart {
  mimeType: string;
  body?: { data: string };
  parts?: MessagePart[];
}

// Match only the SQL this class and the real audit log use. Unexpected queries must fail the test.
class FakeDb {
  agent = { id: AGENT, idx: 1, generation: 1, added_at: new Date(), removing_at: null as Date | null, killed_at: null };
  readonly states = new Map<string, StateRow>();
  readonly connectors = new Map<string, ConnectorRow>();
  readonly auditRows: Record<string, unknown>[] = [];
  readonly kv = new Set<string>();
  private readonly heads = new Map<string, { seq: number; hash: string }>();

  async connect(): Promise<{ query: FakeDb["query"]; release: () => void }> {
    const snapshot = new Map(this.connectors);
    return {
      query: async (sql, values) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql === "ROLLBACK") {
          this.connectors.clear();
          for (const [id, row] of snapshot) this.connectors.set(id, row);
          return { rows: [] };
        }
        return this.query(sql, values);
      },
      release: () => undefined,
    };
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    const sql = text.replace(/\s+/g, " ").trim();
    switch (sql) {
      case "select * from connectors where agent_id = $1 order by id":
        return { rows: [...this.connectors.values()].filter(row => row.agent_id === values[0]).sort((a, b) => a.id.localeCompare(b.id)) };
      case "select 1 from kv where key = $1": return { rows: this.kv.has(String(values[0])) ? [{}] : [] };
      case "insert into kv (key, value) values ($1, 'true'::jsonb) on conflict (key) do nothing": this.kv.add(String(values[0])); return { rows: [] };
      case "delete from kv where key = $1": this.kv.delete(String(values[0])); return { rows: [] };
      case "delete from connectors where agent_id = $1":
        for (const [id, row] of this.connectors) if (row.agent_id === values[0]) this.connectors.delete(id);
        return { rows: [] };
      case "select * from agents where id = $1 and added_at is not null": return { rows: this.agent.added_at ? [{ ...this.agent }] : [] };
      case "insert into connect_states (state_hash, agent_id, app, generation) values ($1, $2, 'gmail', $3)": {
        const row: StateRow = { state_hash: String(values[0]), agent_id: String(values[1]), generation: Number(values[2]), app: "gmail", created_at: new Date(), used_at: null };
        if (this.states.has(row.state_hash)) throw new Error("duplicate state");
        this.states.set(row.state_hash, row);
        return { rows: [] };
      }
      case "update connect_states set used_at = now() where state_hash = $1 and used_at is null and created_at > now() - $2::interval returning agent_id, generation": {
        const row = this.states.get(String(values[0]));
        const minutes = /^(\d+) minutes$/.exec(String(values[1]));
        if (!minutes?.[1]) throw new Error("unexpected state interval");
        if (!row || row.used_at !== null || row.created_at.getTime() <= Date.now() - Number(minutes[1]) * 60_000) return { rows: [] };
        row.used_at = new Date();
        return { rows: [{ agent_id: row.agent_id, generation: row.generation }] };
      }
      case "insert into connectors (id, agent_id, app, account, refresh_enc) values ($1, $2, 'gmail', $3, $4) on conflict (agent_id, app, account) do update set id = excluded.id, refresh_enc = excluded.refresh_enc, created_at = now()": {
        if (!Buffer.isBuffer(values[3])) throw new Error("expected an encrypted bytea");
        const existing = [...this.connectors.values()].find((row) => row.agent_id === values[1] && row.account === values[2]);
        const row: ConnectorRow = {
          id: String(values[0]), agent_id: String(values[1]), app: "gmail", account: String(values[2]),
          refresh_enc: Buffer.from(values[3]), created_at: new Date(),
        };
        if (existing) this.connectors.delete(existing.id);
        this.connectors.set(row.id, row);
        return { rows: [{ id: row.id }] };
      }
      case "select id from agents where id = $1 for update":
        return { rows: [{ id: values[0] }] };
      case "select * from connectors where id = $1": {
        const row = this.connectors.get(String(values[0]));
        return { rows: row ? [row] : [] };
      }
      case "select * from connectors where agent_id = $1 and app = 'gmail'":
        return { rows: [...this.connectors.values()].filter((row) => row.agent_id === values[0]) };
      case "select * from connectors where agent_id = $1 order by created_at":
        return { rows: [...this.connectors.values()].filter((row) => row.agent_id === values[0]).sort((a, b) => a.created_at.getTime() - b.created_at.getTime()) };
      case "select * from connectors where agent_id = $1 and app = 'gmail' order by created_at desc limit 1":
      case "select account from connectors where agent_id = $1 and app = 'gmail' order by created_at desc limit 1":
        return { rows: [...this.connectors.values()].filter((row) => row.agent_id === values[0]).sort((a, b) => b.created_at.getTime() - a.created_at.getTime()).slice(0, 1) };
      case "delete from connectors where id = $1": {
        const row = this.connectors.get(String(values[0]));
        this.connectors.delete(String(values[0]));
        return { rows: row ? [row] : [] };
      }
      case "select pg_advisory_xact_lock(hashtextextended($1, 1))": return { rows: [] };
      case "select seq, hash from audit_heads where agent_id = $1": {
        const head = this.heads.get(String(values[0]));
        return { rows: head ? [head] : [] };
      }
      case "select audit_append($1, $2, $3, $4, $5, $6, $7, $8)":
        this.auditRows.push({ agent_id: values[0], seq: values[1], at: values[2], actor: values[3], type: values[4], data: JSON.parse(String(values[5])), prev_hash: values[6], hash: values[7] });
        this.heads.set(String(values[0]), { seq: Number(values[1]), hash: String(values[7]) });
        return { rows: [] };
      default:
        throw new Error(`Unexpected SQL: ${sql}`);
    }
  }
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    refresh_token: REFRESH, access_token: "exchange-access-token", expires_in: 3600, scope: SCOPES.join(" "),
    id_token: `${encoded('{"alg":"RS256"}')}.${encoded(JSON.stringify({ email: "Owner@Example.COM", email_verified: true }))}.signature`,
    ...overrides,
  });
}

describe("Gmail connectors", () => {
  let db: FakeDb;
  let connectors: Connectors;
  let slots: AgentSlots;
  let log: ReturnType<typeof pino>;
  let logs: string[];
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T10:00:00Z"));
    db = new FakeDb();
    const pool = db as unknown as Db;
    slots = new AgentSlots(pool, { agents: [{ agentId: AGENT }] } as ControlConfig, new AuditLog(pool, KEY));
    logs = [];
    log = pino({}, { write: (text) => { logs.push(text); } });
    connectors = new Connectors(pool, KEY, new AuditLog(pool, Buffer.alloc(32, 9)), ORIGIN, GOOGLE, slots, log);
    fetchMock = vi.fn<typeof fetch>(async (url) => { throw new Error(`Unexpected fetch: ${String(url)}`); });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function state(): Promise<string> {
    const value = new URL(await connectors.start(AGENT)).searchParams.get("state");
    if (!value) throw new Error("consent URL has no state");
    return value;
  }

  async function connect(): Promise<{ agentId: string; account: string; id: string }> {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    return connectors.callback("authorization-code", await state());
  }

  function refresh(access = "access-1", expires = 3600): void {
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: access, expires_in: expires }));
  }

  function request(index: number): { url: URL; init: RequestInit; headers: Headers } {
    const call = fetchMock.mock.calls[index];
    if (!call?.[1]) throw new Error(`missing fetch request ${index}`);
    return { url: new URL(String(call[0])), init: call[1], headers: new Headers(call[1].headers) };
  }

  it("builds consent URLs with every permission and stores unique states only as hashes", async () => {
    const url = new URL(await connectors.start(AGENT));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: GOOGLE.clientId, redirect_uri: `${ORIGIN}/api/connect/google/callback`, response_type: "code",
      scope: SCOPES.join(" "), access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", state: expect.any(String),
    });
    const first = url.searchParams.get("state")!;
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(db.states.get(hash(first))).toEqual({ state_hash: hash(first), agent_id: AGENT, generation: 1, app: "gmail", created_at: new Date(), used_at: null });
    expect(JSON.stringify([...db.states.values()])).not.toContain(first);
    expect(await state()).not.toBe(first);
    expect(db.states.size).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["unknown", "expired", "reused"] as const)("refuses %s states before exchanging a code", async (kind) => {
    const value = await state();
    if (kind === "expired") vi.setSystemTime(Date.now() + 15 * 60_000);
    if (kind === "reused") {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await connectors.callback("first-code", value);
      fetchMock.mockClear();
    }
    await expect(connectors.callback("second-code", kind === "unknown" ? "unknown-state" : value)).rejects.toMatchObject({ status: 400, code: "invalid_state" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses consent states from before the generation migration", async () => {
    const value = await state();
    db.states.get(hash(value))!.generation = null;
    await expect(connectors.callback("code", value)).rejects.toMatchObject({ code: "invalid_state" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["free", "replaced", "removing", "revoke failed"])("rejects a delayed exchange when the slot is %s and revokes its new token", async (kind) => {
    const value = await state();
    let finish!: (response: Response) => void;
    let started!: () => void;
    const exchanging = new Promise<void>((resolve) => { started = resolve; });
    fetchMock.mockImplementationOnce(() => { started(); return new Promise<Response>((resolve) => { finish = resolve; }); });
    const callback = connectors.callback("old-code", value);
    const rejected = expect(callback).rejects.toMatchObject({ status: 409, code: "agent_replaced", message: "This agent was removed before Gmail finished connecting." });
    await exchanging;
    await slots.exclusive(AGENT, async () => {
      if (kind === "free") Object.assign(db.agent, { added_at: null });
      else if (kind === "removing") db.agent.removing_at = new Date();
      else {
        Object.assign(db.agent, { added_at: null });
        db.agent.generation += 1;
        db.agent.added_at = new Date();
      }
    });
    if (kind === "revoke failed") fetchMock.mockRejectedValueOnce(new Error(REFRESH));
    else fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    finish(tokenResponse());
    await rejected;
    expect(request(1).url.href).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(String(request(1).init.body)).get("token")).toBe(REFRESH);
    expect(db.connectors.size).toBe(0);
    expect(db.auditRows).toEqual([]);
    expect(logs.join("")).not.toContain(REFRESH);
    if (kind === "revoke failed") expect(logs.join("")).toContain("revoking Gmail access for a removed agent failed");
  });

  it("accepts a state just under 15 minutes and posts the authorization-code parameters", async () => {
    const value = await state();
    vi.setSystemTime(Date.now() + 15 * 60_000 - 1);
    fetchMock.mockResolvedValueOnce(tokenResponse());
    await connectors.callback("code +/&=", value);
    const { url, init, headers } = request(0);
    expect(url.href).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "authorization_code", code: "code +/&=", redirect_uri: `${ORIGIN}/api/connect/google/callback`,
      client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret,
    });
    expect(db.states.get(hash(value))?.used_at).toEqual(new Date());
  });

  it.each([undefined, ""])("rejects a missing refresh token (%s) without storing a connector", async (refreshToken) => {
    fetchMock.mockResolvedValueOnce(tokenResponse({ refresh_token: refreshToken }));
    const value = await state();
    await expect(connectors.callback("code", value)).rejects.toMatchObject({ status: 502, code: "no_refresh_token" });
    expect(db.connectors.size).toBe(0);
    expect(db.auditRows).toEqual([]);
    await expect(connectors.callback("retry", value)).rejects.toMatchObject({ code: "invalid_state" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(SCOPES.slice(2))("requires Gmail scope %s", async (missing) => {
    fetchMock.mockResolvedValueOnce(tokenResponse({ scope: SCOPES.filter((scope) => scope !== missing).join(" ") }));
    await expect(connectors.callback("code", await state())).rejects.toMatchObject({ status: 400, code: "scope_missing" });
    expect(db.connectors.size).toBe(0);
    expect(db.auditRows).toEqual([]);
  });

  it("takes the lower-case account from the id_token and stores only an encrypted refresh token", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse({ email: "wrong@example.test" }));
    const result = await connectors.callback("code", await state());
    expect(result).toEqual({ agentId: AGENT, account: "owner@example.com", id: expect.any(String) });
    const row = db.connectors.get(result.id)!;
    expect(Buffer.isBuffer(row.refresh_enc)).toBe(true);
    expect(row.refresh_enc.includes(Buffer.from(REFRESH))).toBe(false);
    expect(JSON.stringify([...db.states.values(), ...db.connectors.values(), ...db.auditRows])).not.toContain(REFRESH);
    expect(decryptValue(KEY, `${AGENT}:gmail:owner@example.com`, "refresh", row.refresh_enc)).toBe(REFRESH);
    expect(() => decryptValue(KEY, `${AGENT}:gmail:other@example.com`, "refresh", row.refresh_enc)).toThrow();
    expect(await connectors.gmailAccount(AGENT)).toBe("owner@example.com");
    expect(await connectors.list(AGENT)).toEqual([{ id: result.id, agentId: AGENT, app: "gmail", account: "owner@example.com", connectedAt: new Date().toISOString() }]);
    expect(db.auditRows.at(-1)).toMatchObject({ actor: "owner", type: "connector.added", data: { app: "gmail", account: "owner@example.com" } });
  });

  it("finishes notifying the waiting chat before releasing the slot lock", async () => {
    const value = await state();
    fetchMock.mockResolvedValueOnce(tokenResponse());
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let notify!: () => void;
    const notified = new Promise<void>(resolve => { notify = resolve; });
    const callback = connectors.callback("code", value, async account => {
      expect(account.agentId).toBe(AGENT);
      notify();
      await gate;
    });
    await notified;
    let nextEntered = false;
    const next = slots.exclusive(AGENT, async () => { nextEntered = true; });
    await Promise.resolve();
    expect(nextEntered).toBe(false);
    finish();
    await callback;
    await next;
    expect(nextEntered).toBe(true);
  });

  it("refreshes with the decrypted token, caches access tokens, and refreshes before and after expiry", async () => {
    await connect();
    refresh("access-1", 120);
    fetchMock.mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({}));
    expect(await connectors.gmailSearch(AGENT, "first", 5)).toBe("No messages match.");
    vi.setSystemTime(Date.now() + 59_000);
    await connectors.gmailSearch(AGENT, "cached", 5);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const { init, headers } = request(1);
    expect(init.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "refresh_token", refresh_token: REFRESH, client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret,
    });
    expect(request(2).headers.get("authorization")).toBe("Bearer access-1");
    expect(request(3).headers.get("authorization")).toBe("Bearer access-1");
    vi.setSystemTime(Date.now() + 1_000);
    refresh("access-2", 120);
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await connectors.gmailSearch(AGENT, "refresh-margin", 5);
    expect(request(5).headers.get("authorization")).toBe("Bearer access-2");
    vi.setSystemTime(Date.now() + 121_000);
    refresh("access-3");
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await connectors.gmailSearch(AGENT, "expired", 5);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(request(7).headers.get("authorization")).toBe("Bearer access-3");
  });

  it("drops a cached token after Gmail returns 401 and refreshes on the next call", async () => {
    await connect();
    refresh();
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await connectors.gmailSearch(AGENT, "", 1);
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "Token expired" } }, { status: 401 }));
    await expect(connectors.gmailSearch(AGENT, "", 1)).rejects.toMatchObject({ status: 502, code: "gmail_error", message: "Gmail answered 401: Token expired" });
    expect(request(3).headers.get("authorization")).toBe("Bearer access-1");
    refresh("replacement");
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await connectors.gmailSearch(AGENT, "", 1);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(request(4).url.href).toBe("https://oauth2.googleapis.com/token");
    expect(request(5).headers.get("authorization")).toBe("Bearer replacement");
  });

  it("formats search metadata in result order and sends the query and limit to Gmail", async () => {
    await connect();
    refresh();
    fetchMock.mockResolvedValueOnce(Response.json({ messages: [{ id: "msg001" }, { id: "msg002" }] }));
    for (const n of [1, 2]) fetchMock.mockResolvedValueOnce(Response.json({
      id: `msg00${n}`, snippet: `Preview ${n}`, payload: { headers: [
        { name: "from", value: `Vendor ${n} <vendor${n}@example.test>` }, { name: "SUBJECT", value: `Invoice ${n}` }, { name: "Date", value: `Date ${n}` },
      ] },
    }));
    expect(await connectors.gmailSearch(AGENT, "from:vendor@example.test subject:(invoice & tax)", 2)).toBe(
      "msg001  Date 1\n  From: Vendor 1 <vendor1@example.test>\n  Subject: Invoice 1\n  Preview 1\n" +
      "msg002  Date 2\n  From: Vendor 2 <vendor2@example.test>\n  Subject: Invoice 2\n  Preview 2",
    );
    expect(request(2).url.origin + request(2).url.pathname).toBe(`${GMAIL}/messages`);
    expect(Object.fromEntries(request(2).url.searchParams)).toEqual({ q: "from:vendor@example.test subject:(invoice & tax)", maxResults: "2" });
    for (const [index, id] of [[3, "msg001"], [4, "msg002"]] as const) {
      expect(request(index).url.pathname).toBe(`/gmail/v1/users/me/messages/${id}`);
      expect(request(index).url.searchParams.get("format")).toBe("metadata");
      expect(request(index).url.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "Date"]);
    }
    expect(db.auditRows.at(-1)).toMatchObject({ actor: "agent", type: "connector.used", data: { app: "gmail", op: "search", results: 2 } });
  });

  it.each(["plain", "html", "empty plain"])("reads a multipart message with %s content", async (kind) => {
    await connect();
    refresh();
    const parts: MessagePart[] = [{ mimeType: "text/html", body: { data: encoded("<style>.secret {color:red}</style><script>alert('secret')</script><p>Hello <b>HTML</b></p>") } }];
    if (kind !== "html") parts.push({ mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: encoded(kind === "plain" ? "  Plain žinutė\nkeeps spacing.  " : "") } },
    ] });
    fetchMock.mockResolvedValueOnce(Response.json({ id: "msg001", payload: { mimeType: "multipart/mixed", headers: [
      { name: "FROM", value: "sender@example.test" }, { name: "To", value: "owner@example.com" }, { name: "date", value: "Today" }, { name: "Subject", value: "Invoice" },
    ], parts } }));
    const body = kind === "plain" ? "  Plain žinutė\nkeeps spacing.  " : kind === "html" ? "Hello HTML" : "";
    expect(await connectors.gmailRead(AGENT, "msg001")).toBe(`From: sender@example.test\nTo: owner@example.com\nDate: Today\nSubject: Invoice\n\n${body}`);
    expect(request(2).url.href).toBe(`${GMAIL}/messages/msg001?format=full`);
    expect(db.auditRows.at(-1)).toMatchObject({ actor: "agent", type: "connector.used", data: { app: "gmail", op: "read", messageId: "msg001" } });
  });

  it.each([
    { kind: "plain ASCII", subject: "October invoice" },
    { kind: "UTF-8", subject: "Spalio sąskaita 📨" },
    { kind: "long UTF-8", subject: "Ilga sąskaita 📨 ".repeat(15) },
  ])("creates an RFC 2822 MIME draft with a $kind subject", async ({ subject }) => {
    await connect();
    refresh();
    fetchMock.mockResolvedValueOnce(Response.json({ id: "draft001", message: { id: "msg001" } }));
    const input = { to: ["one@example.test", "two@example.test"], cc: ["copy@example.test"], subject, body: "Labas, pasauli! 📨\n\n" + "Invoice details ž. ".repeat(30) };
    expect(await connectors.gmailCreateDraft(AGENT, input)).toBe("draft001");
    const { url, init, headers } = request(2);
    expect(url.href).toBe(`${GMAIL}/drafts`);
    expect(init.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/json");
    const draft = JSON.parse(String(init.body)) as { message: { raw: string } };
    expect(draft.message.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = Buffer.from(draft.message.raw, "base64url").toString("utf8");
    expect(mime).not.toMatch(/(?<!\r)\n|\r(?!\n)/);
    const [head, body] = mime.split("\r\n\r\n");
    if (head === undefined || body === undefined) throw new Error("draft is missing the header/body boundary");
    expect(head.split("\r\n").every((line) => line.length <= 998)).toBe(true);
    const unfolded = head.replace(/\r\n[ \t]+/g, " ");
    expect(unfolded).toContain(`To: ${input.to.join(", ")}`);
    expect(unfolded).toContain(`Cc: ${input.cc.join(", ")}`);
    const subjectHeader = unfolded.split("\r\n").find((line) => line.startsWith("Subject: "))?.slice(9);
    if (!subjectHeader) throw new Error("draft has no subject");
    if (subject === "October invoice") expect(subjectHeader).toBe(subject);
    else {
      expect(head.split("\r\n").filter((line) => line.startsWith("Subject: ") || line.startsWith(" ")).every((line) => line.length <= 76)).toBe(true);
      const words = subjectHeader.split(" ");
      expect(words.every((word) => word.length <= 75 && /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(word))).toBe(true);
      expect(words.map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join("")).toBe(subject);
    }
    expect(unfolded).toContain("MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64");
    expect(body.split("\r\n").every((line) => line.length <= 76)).toBe(true);
    expect(Buffer.from(body, "base64").toString("utf8")).toBe(input.body);
    expect(db.auditRows.at(-1)).toMatchObject({ actor: "agent", type: "connector.used", data: { app: "gmail", op: "create_draft", draftId: "draft001", to: { hmac: expect.any(String), length: JSON.stringify(input.to).length } } });
  });

  it("replaces the previous account only after storing the new account, then revokes and deletes it", async () => {
    const old = await connect();
    const nextState = await state();
    fetchMock.mockResolvedValueOnce(tokenResponse({
      refresh_token: "refresh-B", id_token: `h.${encoded(JSON.stringify({ email: "b@example.test" }))}.s`,
    }));
    fetchMock.mockImplementationOnce(async () => {
      expect([...db.connectors.values()].map((row) => row.account)).toContain("b@example.test");
      expect(db.connectors.has(old.id)).toBe(true);
      return new Response(null, { status: 200 });
    });
    const current = await connectors.callback("code-B", nextState);
    expect(current.id).not.toBe(old.id);
    expect(await connectors.list(AGENT)).toEqual([expect.objectContaining({ id: current.id, account: "b@example.test" })]);
    expect(new URLSearchParams(String(request(2).init.body)).get("token")).toBe(REFRESH);
    expect(db.auditRows.slice(-2).map((row) => row.type)).toEqual(["connector.removed", "connector.added"]);
  });

  it("drops an in-flight refresh for A after B connects and never sends A's token to Gmail", async () => {
    await connect();
    let finishRefresh!: (response: Response) => void;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    fetchMock.mockImplementationOnce(() => {
      started();
      return new Promise<Response>((resolve) => { finishRefresh = resolve; });
    });
    const search = connectors.gmailSearch(AGENT, "private query", 1);
    const rejected = expect(search).rejects.toMatchObject({ status: 409, code: "connection_changed" });
    await inFlight;
    fetchMock.mockResolvedValueOnce(tokenResponse({
      refresh_token: "refresh-B", id_token: `h.${encoded(JSON.stringify({ email: "b@example.test" }))}.s`,
    })).mockResolvedValueOnce(new Response(null, { status: 200 }));
    await connectors.callback("code-B", await state());
    finishRefresh(Response.json({ access_token: "access-A", expires_in: 3600 }));
    await rejected;
    refresh("access-B");
    fetchMock.mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({}));
    await connectors.gmailSearch(AGENT, "B", 1);
    await connectors.gmailSearch(AGENT, "B cached", 1);
    expect(new URLSearchParams(String(request(4).init.body)).get("refresh_token")).toBe("refresh-B");
    expect(request(5).headers.get("authorization")).toBe("Bearer access-B");
    expect(request(6).headers.get("authorization")).toBe("Bearer access-B");
    expect(fetchMock.mock.calls.some((call) => new Headers(call[1]?.headers).get("authorization") === "Bearer access-A")).toBe(false);
  });

  it("invalidates cached access when the same account reconnects without revoking the new grant", async () => {
    const first = await connect();
    refresh("old-access");
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await connectors.gmailSearch(AGENT, "", 1);
    const next = await connect();
    expect(next.id).not.toBe(first.id);
    expect(db.connectors.size).toBe(1);
    refresh("new-access");
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await connectors.gmailSearch(AGENT, "", 1);
    expect(request(5).headers.get("authorization")).toBe("Bearer new-access");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/revoke"))).toBe(false);
  });

  it.each(["http 400", "http 500", "network", "timeout"])("keeps the connector and cache without an audit entry when revoke fails: %s", async (failure) => {
    const { id } = await connect();
    refresh();
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await connectors.gmailSearch(AGENT, "", 1);
    const auditBefore = [...db.auditRows];
    if (failure.startsWith("http")) fetchMock.mockResolvedValueOnce(new Response(null, { status: Number(failure.slice(5)) }));
    else if (failure === "network") fetchMock.mockRejectedValueOnce(new TypeError("Network down"));
    else {
      // Use a short real timeout so this exercises AbortSignal, not an already-rejected fetch.
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(5));
      fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
      await expect(connectors.remove(id)).rejects.toMatchObject({ status: 502, message: "Google did not confirm the disconnect; try again" });
      spy.mockRestore();
    }
    if (failure !== "timeout") await expect(connectors.remove(id)).rejects.toMatchObject({ status: 502, code: "google_revoke" });
    expect(db.connectors.has(id)).toBe(true);
    expect(db.auditRows).toEqual(auditBefore);
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await connectors.gmailSearch(AGENT, "still connected", 1);
    expect(request(4).headers.get("authorization")).toBe("Bearer access-1");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("removes and revokes a connector, audits it and invalidates cached access", async () => {
    const { id } = await connect();
    refresh();
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await connectors.gmailSearch(AGENT, "", 1);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await connectors.remove(id);
    expect(await connectors.list(AGENT)).toEqual([]);
    expect(await connectors.gmailAccount(AGENT)).toBeNull();
    const { url, init, headers } = request(3);
    expect(url.href).toBe("https://oauth2.googleapis.com/revoke");
    expect(init.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ token: REFRESH });
    expect(db.auditRows.at(-1)).toMatchObject({ agent_id: AGENT, actor: "owner", type: "connector.removed", data: { app: "gmail", account: "owner@example.com" } });
    await expect(connectors.gmailSearch(AGENT, "", 1)).rejects.toMatchObject({ status: 409, code: "not_connected" });
    await expect(connectors.remove(id)).rejects.toMatchObject({ status: 404, code: "unknown_connector" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("confirms every agent revoke before deleting any connector and resumes confirmed revokes after restart", async () => {
    const { id } = await connect();
    const first = db.connectors.get(id)!;
    db.connectors.set("zz-last", { ...first, id: "zz-last", account: "other@example.com", refresh_enc: encryptValue(KEY, `${AGENT}:gmail:other@example.com`, "refresh", "other-refresh") });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(connectors.removeAgent(AGENT)).rejects.toMatchObject({ status: 502, code: "google_revoke" });
    expect(db.connectors.size).toBe(2);
    expect(db.kv.has(`connector_revoked:${id}`)).toBe(true);
    const restarted = new Connectors(db as unknown as Db, KEY, new AuditLog(db as unknown as Db, KEY), ORIGIN, GOOGLE, slots, log);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await restarted.removeAgent(AGENT);
    expect(db.connectors.size).toBe(0);
    expect(db.kv.size).toBe(0);
    const revokes = fetchMock.mock.calls.filter(([url]) => String(url) === "https://oauth2.googleapis.com/revoke");
    expect(revokes).toHaveLength(3);
    expect(revokes.filter(([, init]) => new URLSearchParams(String(init?.body)).get("token") === REFRESH)).toHaveLength(1);
  });
});
