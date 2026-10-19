import pino from "pino";
import { Duplex } from "node:stream";
import { Auth } from "../src/auth.js";
import { TaskService } from "../src/tasks.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsRequest } from "@quokkabot/shared";
import { AgentSlots, capacityMessage, type SlotRow } from "../src/agents.js";
import type { AuditLog } from "../src/audit.js";
import { ControlConfigFile, type ControlConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { HttpError } from "../src/errors.js";
import { buildServer, type HttpDeps } from "../src/http.js";
import { Connectors } from "../src/connectors.js";
import { ClaudeSignIns } from "../src/claude-sign-in.js";

const ids = [1, 2, 3].map(index => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
const config = {
  ...ControlConfigFile.parse({
    appOrigin: "https://quokkabot.test", viewOrigin: "https://view.quokkabot.test", ownerName: "Owner",
    dataRoot: "/data", secretsDir: "/secrets", database: { host: "db", port: 5432, name: "quokkabot", ownerUser: "owner", appUser: "app" },
    supervisorSocket: "/supervisor.sock", egressUrl: "http://egress:8080",
    agents: ids.map((agentId, offset) => ({ agentId, index: offset + 1, name: `Agent ${offset + 1}`,
      mcpUrl: `http://10.231.${offset + 1}.3:8090/mcp`, browserServiceUrl: `http://10.232.${offset + 1}.10:8091`, selkiesUrl: `http://10.232.${offset + 1}.10:3000`, downloadsDir: `/data/agents/${offset + 1}/downloads` })),
  }),
  appHost: "quokkabot.test", viewHost: "view.quokkabot.test", secrets: { sessionSecret: Buffer.alloc(32, 1) },
} as ControlConfig;

interface Row extends SlotRow { name: string; model: string; effort: string; cli_signed_in: string }
// Only the slot SQL is simulated here. The Docker integration suite exercises PostgreSQL locks and cascades.
class SlotDb {
  readonly rows = new Map<string, Row>();
  readonly reserved = new Set<string>();
  readonly calls: string[] = [];
  resourceAgent: string | null = null;
  async connect() {
    const held = new Set<string>();
    return { query: async (sql: string, values: unknown[] = []) => {
      if (sql === "COMMIT" || sql === "ROLLBACK") { for (const id of held) this.reserved.delete(id); return { rows: [] }; }
      if (sql === "BEGIN") return { rows: [] };
      if (sql.includes("skip locked")) {
        this.calls.push(sql);
        const allowed = values[0] as string[];
        const row = [...this.rows.values()].filter(row => allowed.includes(row.id) && row.added_at === null && !this.reserved.has(row.id)).sort((a, b) => a.idx - b.idx)[0];
        if (row) { this.reserved.add(row.id); held.add(row.id); }
        return { rows: row ? [{ id: row.id }] : [] };
      }
      return this.query(sql, values);
    }, release: () => undefined };
  }
  async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push(sql);
    const id = String(values[0]);
    const row = this.rows.get(id);
    if (sql.includes("insert into agents")) {
      if (!row) this.rows.set(id, { id, idx: Number(values[1]), generation: 1, name: String(values[2]), model: String(values[3]), effort: String(values[4]),
        cli_signed_in: "unknown", added_at: values[1] === 1 ? new Date() : null, removing_at: null, killed_at: null });
      return { rows: [] };
    }
    if (sql.startsWith("select id from agents where id = any")) return { rows: [...this.rows.values()].filter(row => (values[0] as string[]).includes(row.id) && row.added_at).sort((a, b) => a.idx - b.idx).map(row => ({ id: row.id })) };
    if (sql.startsWith("select * from agents")) return { rows: row && (!sql.includes("added_at is not null") || row.added_at) ? [{ ...row }] : [] };
    if (sql.startsWith("update agents set name")) { Object.assign(row!, { name: values[1], model: values[2], effort: values[3], cli_signed_in: "no", generation: row!.generation + 1, added_at: new Date() }); return { rows: [] }; }
    if (sql.startsWith("update agents set removing_at")) { row!.removing_at = new Date(); return { rows: [] }; }
    if (sql.includes("update agents set added_at = null")) { Object.assign(row!, { name: values[1], model: values[2], effort: values[3], cli_signed_in: "no", added_at: null, removing_at: null }); return { rows: [] }; }
    if (sql.startsWith("update agents set model")) { Object.assign(row!, { model: values[1], effort: values[2], name: values[3] ?? row!.name }); return { rows: [] }; }
    if (sql.startsWith("select id, idx, generation, removing_at")) return { rows: row ? [{ ...row }] : [] };
    if (sql.includes("as n")) return { rows: [{ n: 0 }] };
    if (sql.startsWith("select id from tasks")) return { rows: [] };
    if (sql.startsWith("select 1 from tasks")) return { rows: [] };
    if (sql.startsWith("select agent_id from") || sql.startsWith("select t.agent_id")) return { rows: this.resourceAgent ? [{ agent_id: this.resourceAgent }] : [] };
    if (sql.startsWith("delete from") || sql.startsWith("insert into domain_rules")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

async function fixture() {
  const db = new SlotDb();
  const audit = { append: vi.fn(async (_agentId: string, _actor: string, _type: string, _data: unknown, _tx?: unknown) => undefined) };
  const slots = new AgentSlots(db as unknown as Db, config, audit as unknown as AuditLog);
  await slots.initialize();
  const row = db.rows.get(ids[0]!)!;
  const steps: string[] = [];
  const deps = {
    dropSignIns: vi.fn((_agentId: string) => undefined),
    drainTools: vi.fn(async () => { steps.push("drain"); }),
    tasks: { cancelAgent: vi.fn(async () => { steps.push("cancel"); }) },
    computer: { stop: vi.fn(async () => { steps.push("stop"); }) },
    supervisor: { computer: vi.fn(async () => ({ killed: false })), wipe: vi.fn(async () => { steps.push("wipe"); }) },
    connectors: { removeAgent: vi.fn(async () => { steps.push("revoke"); }) },
    policy: { forgetAgent: vi.fn(), push: vi.fn(async () => { steps.push("policy"); }) }, closeRelays: () => { steps.push("relays"); },
  };
  return { db, slots, audit, row, steps, deps };
}

describe("agent slots", () => {
  it("revokes a Gmail token exchanged across actual removal and recreation of the slot", async () => {
    const { db, slots, row, deps, audit } = await fixture();
    const query = db.query.bind(db);
    let generation = 0;
    vi.spyOn(db, "query").mockImplementation(async (sql, values = []) => {
      if (sql.startsWith("insert into connect_states")) { generation = Number(values[2]); return { rows: [] }; }
      if (sql.startsWith("update connect_states")) return { rows: [{ agent_id: row.id, generation }] };
      return query(sql, values);
    });
    const connectors = new Connectors(db as unknown as Db, Buffer.alloc(32), audit as unknown as AuditLog, config.appOrigin,
      { clientId: "test", clientSecret: "test" }, slots, pino({ level: "silent" }));
    const url = new URL(await slots.exclusive(row.id, () => connectors.start(row.id)));
    let finish!: (response: Response) => void;
    let started!: () => void;
    const exchanging = new Promise<void>(resolve => { started = resolve; });
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(() => { started(); return new Promise<Response>(resolve => { finish = resolve; }); })
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const callback = connectors.callback("code", url.searchParams.get("state")!);
      const rejected = expect(callback).rejects.toMatchObject({ code: "agent_replaced" });
      await exchanging;
      await slots.remove(row.id, deps as unknown as Parameters<AgentSlots["remove"]>[1]);
      expect(await slots.create("Replacement")).toBe(row.id);
      finish(Response.json({ refresh_token: "old-occupant-refresh" }));
      await rejected;
      expect(row.generation).toBe(generation + 1);
      expect(fetchMock.mock.calls[1]?.[0]).toBe("https://oauth2.googleapis.com/revoke");
      expect(audit.append.mock.calls.some(call => call[2] === "connector.added")).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it("drops a delayed Claude submission across actual removal and recreation of the slot", async () => {
    const { db, slots, row, deps, audit } = await fixture();
    const signInId = ids[2]!;
    const supervisor = { startSignIn: vi.fn(async () => ({ signInId, url: "https://claude.com/cai/oauth/authorize?state=test" })), submitSignIn: vi.fn() };
    const signIns = new ClaudeSignIns(db as unknown as Db, supervisor as never, { isRunning: async () => true } as never, audit as unknown as AuditLog, slots);
    await slots.exclusive(row.id, () => signIns.start(row.id));
    deps.dropSignIns.mockImplementation(agentId => { signIns.dropAgent(agentId); });
    const acquire = slots.acquire.bind(slots);
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    // Delay the request before it obtains the slot lock, while removal and creation finish normally.
    vi.spyOn(slots, "acquire").mockImplementationOnce(async id => { await gate; return acquire(id); });
    const submission = signIns.submit(signInId, { code: "abcdefgh#abcdefgh" });
    const rejected = expect(submission).rejects.toMatchObject({ code: "unknown_sign_in" });
    await slots.remove(row.id, deps as unknown as Parameters<AgentSlots["remove"]>[1]);
    expect(await slots.create("Replacement")).toBe(row.id);
    resume();
    await rejected;
    expect(row.cli_signed_in).toBe("no");
    expect(supervisor.submitSignIn).not.toHaveBeenCalled();
    expect(audit.append.mock.calls.some(call => call[2] === "claude.signed_in")).toBe(false);
  });

  it("seeds only slot 1 and preserves a name and free state across startup", async () => {
    const { db, slots, row } = await fixture();
    row.name = "Invoices";
    await slots.initialize();
    expect(row.name).toBe("Invoices");
    expect(await slots.ids()).toEqual([ids[0]]);
    row.added_at = null;
    await slots.initialize();
    expect(await slots.ids()).toEqual([]);
    expect(db.calls.filter(sql => sql.includes("insert into agents")).every(sql => sql.includes("on conflict (id) do nothing"))).toBe(true);
  });
  it("claims the lowest free slot and resets its settings and sign-in", async () => {
    const { db, slots, audit } = await fixture();
    expect(await slots.create("Accounts")).toBe(ids[1]);
    expect(db.rows.get(ids[1]!)).toMatchObject({ name: "Accounts", generation: 2, model: config.defaultModel, effort: config.defaultEffort, cli_signed_in: "no" });
    expect(audit.append).toHaveBeenCalledWith(ids[1], "owner", "agent.added", { name: "Accounts" }, expect.anything());
  });
  it("concurrent creates reserve different slots and then return a full response", async () => {
    const { slots } = await fixture();
    const created = await Promise.all([slots.create("Two"), slots.create("Three")]);
    expect(new Set(created)).toEqual(new Set(ids.slice(1)));
    await expect(slots.create("Four")).rejects.toMatchObject({ status: 409, code: "no_free_slot", message: capacityMessage(3) });
  });
  it("two creates for one remaining slot produce one success and one conflict", async () => {
    const { slots } = await fixture();
    await slots.create("Two");
    const results = await Promise.allSettled([slots.create("Three"), slots.create("Four")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409, code: "no_free_slot" } });
  });
  it("ignores database agents that are no longer configured", async () => {
    const { db, slots, row } = await fixture();
    db.rows.set("99999999-9999-4999-8999-999999999999", { ...row, id: "99999999-9999-4999-8999-999999999999", idx: 9 });
    expect(await slots.ids()).toEqual([ids[0]]);
    await expect(slots.require("99999999-9999-4999-8999-999999999999")).rejects.toMatchObject({ status: 404, code: "unknown_agent" });
  });
  it("orders removal, retains the audit chain and frees the slot last", async () => {
    const { slots, db, row, deps, steps, audit } = await fixture();
    deps.supervisor.wipe.mockImplementation(async () => {
      steps.push("wipe");
      expect(row.added_at).not.toBeNull();
      expect(db.calls.some(sql => sql.startsWith("delete from tasks"))).toBe(true);
      expect(db.calls.some(sql => /delete from audit/.test(sql))).toBe(false);
    });
    await slots.remove(row.id, deps as unknown as Parameters<AgentSlots["remove"]>[1]);
    expect(steps).toEqual(["relays", "cancel", "stop", "drain", "revoke", "policy", "wipe"]);
    expect(deps.dropSignIns).toHaveBeenCalledWith(row.id);
    expect(row).toMatchObject({ added_at: null, removing_at: null, name: "Agent 1", cli_signed_in: "no" });
    expect(audit.append).toHaveBeenCalledWith(row.id, "owner", "agent.removed", {}, expect.anything());
    expect(slots.knownIds.has(row.id)).toBe(false);
  });
  it.each(["database", "supervisor"])("refuses removal when the %s kill latch is set", async source => {
    const { slots, row, deps, steps, db } = await fixture();
    if (source === "database") row.killed_at = new Date();
    else deps.supervisor.computer.mockResolvedValue({ killed: true });
    await expect(slots.remove(row.id, deps as unknown as Parameters<AgentSlots["remove"]>[1])).rejects.toMatchObject({ status: 409, message: "Release the kill switch first" });
    expect(steps).toEqual([]);
    expect(db.calls.some(sql => sql.startsWith("delete"))).toBe(false);
  });
  it("a failed revoke deletes nothing and leaves a durable retry fence", async () => {
    const { slots, row, deps, db, steps } = await fixture();
    deps.connectors.removeAgent.mockRejectedValue(new HttpError(502, "google_revoke", "Google did not confirm the disconnect; try again"));
    await expect(slots.remove(row.id, deps as unknown as Parameters<AgentSlots["remove"]>[1])).rejects.toMatchObject({ status: 502 });
    expect(steps).toEqual(["relays", "cancel", "stop", "drain"]);
    expect(db.calls.some(sql => sql.startsWith("delete"))).toBe(false);
    expect(row.added_at).not.toBeNull();
    expect(row.removing_at).not.toBeNull();
    await expect(slots.require(row.id, false)).rejects.toMatchObject({ status: 409, code: "agent_removing" });
  });
  it("a failed wipe can be retried before the slot becomes free", async () => {
    const { slots, row, deps } = await fixture();
    deps.supervisor.wipe.mockRejectedValueOnce(new Error("disk error"));
    await expect(slots.remove(row.id, deps as unknown as Parameters<AgentSlots["remove"]>[1])).rejects.toThrow("disk error");
    expect(row.added_at).not.toBeNull();
    await slots.remove(row.id, deps as unknown as Parameters<AgentSlots["remove"]>[1]);
    expect(row.added_at).toBeNull();
    expect(await slots.create("Replacement")).toBe(row.id);
    expect(row.generation).toBe(2);
  });
});

const servers: Awaited<ReturnType<typeof buildServer>>["app"][] = [];
afterEach(async () => { for (const app of servers.splice(0)) await app.close(); });
async function httpFixture() {
  const fixtureData = await fixture();
  const { slots, db, audit } = fixtureData;
  const computer = { releaseKill: vi.fn(async () => undefined), view: vi.fn(async () => ({ state: "stopped", sandboxes: [], lease: { holder: "paused", generation: 1, expiresAt: null }, attendedOpen: false, killedAt: null })) };
  const { app } = await buildServer({ config, slots, db, audit, computer, vault: { list: vi.fn() }, auth: { session: async () => ({ hash: "owner", freshUntil: new Date(Date.now() + 10000) }) },
    log: pino({ level: "silent" }), webRoot: "/missing" } as unknown as HttpDeps);
  servers.push(app);
  const headers = { host: config.appHost, origin: config.appOrigin };
  return { ...fixtureData, app, headers, computer };
}

describe("owner agent routes", () => {
  it.each(["", "/tasks", "/logins", "/connectors", "/domains", "/files", "/audit"])("a free slot returns unknown_agent for GET %s", async path => {
    const { app, headers, computer } = await httpFixture();
    const result = await app.inject({ method: "GET", url: `/api/agents/${ids[1]}${path}`, headers });
    expect(result.statusCode).toBe(404);
    expect(result.json()).toEqual({ error: { code: "unknown_agent", message: "No such agent." } });
    expect(computer.view).not.toHaveBeenCalled();
  });
  it.each(["/view-ticket", "/computer/start", "/kill"])("a free slot returns unknown_agent for POST %s", async path => {
    const { app, headers } = await httpFixture();
    const result = await app.inject({ method: "POST", url: `/api/agents/${ids[1]}${path}`, headers, payload: {} });
    expect(result.statusCode).toBe(404);
    expect(result.json().error.code).toBe("unknown_agent");
  });
  it("lists only added agents and includes capacity and a stable index", async () => {
    const { app, headers } = await httpFixture();
    const result = await app.inject({ url: "/api/agents", headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ agents: [{ id: ids[0], index: 1 }], capacity: { used: 1, total: 3 } });
    expect(result.json().agents).toHaveLength(1);
  });
  it("creates through the API, and trims and saves names through settings", async () => {
    const { app, headers, row } = await httpFixture();
    const created = await app.inject({ method: "POST", url: "/api/agents", headers, payload: { name: "  New  " } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: ids[1], name: "New", index: 2, cliSignedIn: "no" });
    const result = await app.inject({ method: "PUT", url: `/api/agents/${row.id}/settings`, headers, payload: { name: "  Invoices  ", model: config.defaultModel, effort: config.defaultEffort } });
    expect(result.statusCode).toBe(200);
    expect(result.json().name).toBe("Invoices");
  });
  it.each(["/api/tasks/", "/api/files/", "/api/logins/", "/api/connectors/"])("rejects old resources of a free slot at %s", async prefix => {
    const { app, headers, db } = await httpFixture();
    db.resourceAgent = ids[1]!;
    const url = `${prefix}${ids[2]}${prefix.includes("files") ? "/content" : ""}`;
    const method = prefix.includes("connectors") || prefix.includes("logins") ? "DELETE" : "GET";
    const result = await app.inject({ method, url, headers });
    expect(result.statusCode).toBe(404);
    expect(result.json().error.code).toBe("unknown_agent");
  });
  it("allows kill release on an interrupted removal while refusing other mutations", async () => {
    const { app, headers, row, computer } = await httpFixture();
    row.removing_at = new Date();
    row.killed_at = new Date();
    const settings = await app.inject({ method: "PUT", url: `/api/agents/${row.id}/settings`, headers, payload: { name: "New", model: config.defaultModel, effort: config.defaultEffort } });
    expect(settings.statusCode).toBe(409);
    const release = await app.inject({ method: "POST", url: `/api/agents/${row.id}/kill/release`, headers, payload: {} });
    expect(release.statusCode).toBe(200);
    expect(computer.releaseKill).toHaveBeenCalledWith(row.id);
  });
  it("leaves DELETE query strings to the removal service's own lock", async () => {
    const { app, headers, row, slots } = await httpFixture();
    vi.spyOn(slots, "remove").mockResolvedValue();
    const acquire = vi.spyOn(slots, "acquire");
    expect((await app.inject({ method: "DELETE", url: `/api/agents/${row.id}?retry=1`, headers })).statusCode).toBe(200);
    expect(acquire).not.toHaveBeenCalled();
  });
  it("enforces trimmed name length", () => {
    expect(AgentSettingsRequest.parse({ name: " A ", model: config.defaultModel, effort: config.defaultEffort }).name).toBe("A");
    for (const name of ["   ", "x".repeat(41)]) expect(AgentSettingsRequest.safeParse({ name, model: config.defaultModel, effort: config.defaultEffort }).success).toBe(false);
  });
});


describe("free-slot capabilities", () => {
  it.each(["terminal", "viewer"])("refuses a free slot on the %s WebSocket before opening an upstream", async kind => {
    const { app, headers } = await httpFixture();
    let output = "";
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
    app.server.emit("upgrade", {
      url: kind === "terminal" ? `/api/agents/${ids[1]}/terminal` : `/agents/${ids[1]}/api/websockets`,
      headers: { host: kind === "terminal" ? config.appHost : config.viewHost, origin: kind === "terminal" ? headers.origin : config.viewOrigin },
    }, socket, Buffer.alloc(0));
    await vi.waitFor(() => expect(output).toContain("HTTP/1.1 404"));
    expect(socket.destroyed).toBe(true);
  });
  it("rejects view-ticket creation, redemption and viewer sessions for a free slot", async () => {
    const { db, audit, slots } = await fixture();
    const auth = new Auth(db as unknown as Db, config, audit as unknown as AuditLog, () => slots.ids());
    await expect(auth.createViewTicket(ids[1]!, "owner")).rejects.toMatchObject({ status: 404, code: "unknown_agent" });
    await expect(auth.redeemViewTicket("ticket", ids[1]!)).rejects.toMatchObject({ status: 404, code: "unknown_agent" });
    await expect(auth.viewSession("cookie", ids[1]!)).rejects.toMatchObject({ status: 404, code: "unknown_agent" });
  });
});

describe("removal cancellation", () => {
  it("fences runs and cancels queued tasks without deleting session data before revocation", async () => {
    const calls: string[] = [];
    const query = async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("update tasks")) return { rows: [{ id: ids[2], agent_id: ids[0] }] };
      if (sql.startsWith("select * from runs")) return { rows: [{ id: "run", agent_id: ids[0] }] };
      return { rows: [] };
    };
    const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Db;
    const cleanupRun = vi.fn();
    const cancelRun = vi.fn(async () => undefined);
    const events = { append: vi.fn(async () => undefined) };
    const tasks = new TaskService(db, events as never, {} as never, { cancelRun, cleanupRun, run: async () => ({ state: "cancelled" }) } as never,
      {} as never, {} as never, pino({ level: "silent" }), () => [ids[0]!]);
    vi.spyOn(tasks, "watch").mockImplementation(() => undefined);
    await tasks.cancelAgent(ids[0]!);
    expect(cancelRun).toHaveBeenCalledWith("run");
    expect(calls.some(sql => sql.includes("token_revoked = true") && sql.includes("agent_removing"))).toBe(true);
    expect(calls.some(sql => sql.startsWith("delete"))).toBe(false);
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(events.append).toHaveBeenCalledWith(expect.anything(), ids[2], { kind: "state", state: "cancelled", blockedReason: null });
  });
});
