import http from "node:http";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { AgentSlots } from "../src/agents.js";
import { buildServer, type HttpDeps } from "../src/http.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const headers = { host: "quokkabot.test", origin: "https://quokkabot.test" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

async function fixture() {
  const row = { id: agentId, idx: 1, generation: 2, name: "New occupant", model: "claude-opus-4-6", effort: "high", cli_signed_in: "no", cli_account: null, cli_plan: null,
    added_at: new Date() as Date | null, removing_at: null, killed_at: null };
  const write = vi.fn();
  const create = vi.fn(async () => ({ id: attachmentId, agent_id: agentId, title: "Task", state: "queued", blocked_reason: null, model: row.model, effort: row.effort,
    created_at: new Date(), updated_at: new Date(), result_summary: null, error: null }));
  const deps = {
    config: { agents: [{ agentId }], appOrigin: headers.origin, appHost: headers.host, viewHost: "view.test", viewOrigin: "https://view.test" },
    db: { query: async (sql: string, values: unknown[]) => {
      if (sql.startsWith("select * from agents")) return { rows: row.added_at ? [{ ...row }] : [] };
      if (sql.startsWith("select id, idx, generation")) return { rows: [{ ...row }] };
      if (sql.startsWith("select id from tasks")) return { rows: [] };
      if (sql.startsWith("select id, signed_in_at from claude_sign_in")) return { rows: [] };
      if (sql.includes("as n")) return { rows: [{ n: 0 }] };
      if (sql.startsWith("update agents set model")) { write(sql); row.name = String(values[3]); return { rows: [] }; }
      if (sql.startsWith("delete from attachments")) { write(sql); return { rows: [] }; }
      if (sql.startsWith("insert into attachments")) {
        write(sql);
        return { rows: [{ id: attachmentId, name: "test.png", media_type: "image/png", bytes: png.length, width: 1, height: 1 }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    } },
    auth: { session: async () => ({ hash: "owner" }) },
    consents: { view: async () => ({ provider: "anthropic", disclosureVersion: "test", state: "not_asked", required: false, allowed: true, changedAt: null, changedBy: null }) },
    tasks: { create }, audit: { append: vi.fn(), textDigest: () => ({ hmac: "digest", length: 8 }) },
    computer: { view: async () => ({ state: "stopped", sandboxes: [], lease: { holder: "paused", generation: 1, expiresAt: null }, attendedOpen: false, killedAt: null }) },
    log: pino({ level: "silent" }), webRoot: "/missing",
  } as unknown as HttpDeps;
  deps.slots = new AgentSlots(deps.db, deps.config, deps.audit);
  return { ...(await buildServer(deps)), deps, row, write, create };
}

describe("owner mutation generation fence", () => {
  for (const route of ["attachments", "tasks", "settings"] as const) {
    it.each(["1", "2", undefined])(`${route} rejects an old generation and accepts a matching or absent header: %s`, async generation => {
      const { app, write, create, deps, row } = await fixture();
      const originalName = row.name;
      try {
        const result = await app.inject({ method: route === "settings" ? "PUT" : "POST", url: `/api/agents/${agentId}/${route}?name=test.png`,
          headers: { ...headers, ...(generation === undefined ? {} : { "x-quokkabot-agent-generation": generation }),
            "content-type": route === "attachments" ? "image/png" : "application/json" },
          payload: route === "attachments" ? png : route === "tasks" ? { prompt: "Hello" } : { name: "Changed", model: row.model, effort: row.effort } });
        if (generation === "1") {
          expect(result.statusCode).toBe(409);
          expect(result.json()).toEqual({ error: { code: "agent_replaced", message: "This agent was removed. Reload to see the current agents." } });
          expect(write).not.toHaveBeenCalled();
          expect(create).not.toHaveBeenCalled();
          expect(deps.audit.append).not.toHaveBeenCalled();
          expect(row.name).toBe(originalName);
        } else {
          expect(result.statusCode).toBe(200);
          if (route === "tasks") expect(create).toHaveBeenCalledWith(agentId, "Hello", undefined, []);
          else expect(write).toHaveBeenCalled();
        }
        // An error in preHandler must release the lock too.
        const release = await deps.slots.acquire(agentId);
        release();
      } finally { await app.close(); }
    });
  }

  it("never makes the kill switch wait for the agent lock, with or without a generation", async () => {
    const { app, deps } = await fixture();
    const release = await deps.slots.acquire(agentId);
    try {
      for (const extra of [{}, { "x-quokkabot-agent-generation": "2" }]) {
        const answered = app.inject({ method: "POST", url: `/api/agents/${agentId}/kill`, headers: { ...headers, ...extra }, payload: {} }).then(() => "answered");
        const timeout = new Promise(resolve => setTimeout(() => resolve("waited for the lock"), 2000));
        expect(await Promise.race([answered, timeout])).toBe("answered");
      }
    } finally { release(); await app.close(); }
  });

  it("treats an empty slot as replaced when the client supplied a generation", async () => {
    const { app, row } = await fixture();
    row.added_at = null;
    try {
      const result = await app.inject({ method: "POST", url: `/api/agents/${agentId}/tasks`, headers: { ...headers, "x-quokkabot-agent-generation": "2" }, payload: { prompt: "Old request" } });
      expect(result.statusCode).toBe(409);
      expect(result.json().error.code).toBe("agent_replaced");
    } finally { await app.close(); }
  });

  it("checks a stale DELETE generation inside removal's own lock", async () => {
    const { app, write, deps } = await fixture();
    const acquire = vi.spyOn(deps.slots, "acquire");
    try {
      const result = await app.inject({ method: "DELETE", url: `/api/agents/${agentId}`, headers: { ...headers, "x-quokkabot-agent-generation": "1" } });
      expect(result.statusCode).toBe(409);
      expect(result.json().error.code).toBe("agent_replaced");
      expect(acquire).toHaveBeenCalledExactlyOnceWith(agentId);
      expect(write).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

describe("handler lock lifetime", () => {
  it("keeps the lock after an early response until the handler's work finishes", async () => {
    const { app, deps } = await fixture();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    app.post("/api/agents/:agentId/early", async (_request, reply) => { void reply.send({}); await gate; });
    try {
      expect((await app.inject({ method: "POST", url: `/api/agents/${agentId}/early`, headers, payload: {} })).statusCode).toBe(200);
      let nextEntered = false;
      const next = deps.slots.exclusive(agentId, async () => { nextEntered = true; });
      await Promise.resolve();
      expect(nextEntered).toBe(false);
      finish();
      await next;
      expect(nextEntered).toBe(true);
    } finally { finish(); await app.close(); }
  });

  it.each(["return", "throw"])("holds the lock through handler completion and releases on %s", async outcome => {
    const { app, deps } = await fixture();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    app.post("/api/agents/:agentId/slow", async () => { started(); await gate; if (outcome === "throw") throw new Error("handler failed"); });
    try {
      const request = app.inject({ method: "POST", url: `/api/agents/${agentId}/slow`, headers, payload: {} }).then(result => result);
      await entered;
      let nextEntered = false;
      const next = deps.slots.exclusive(agentId, async () => { nextEntered = true; });
      await Promise.resolve();
      expect(nextEntered).toBe(false);
      finish();
      expect((await request).statusCode).toBe(outcome === "throw" ? 500 : 200);
      await next;
      expect(nextEntered).toBe(true);
    } finally { finish(); await app.close(); }
  });
});

// Listening sockets are unavailable in the local sandbox. The Linux integration run exercises real disconnects.
describe.skipIf(process.env.QB_INTEGRATION !== "1")("disconnected owner mutation", () => {
  it.each(["return", "reply", "throw"])("releases only after the disconnected handler finishes by %s", async outcome => {
    const { app, deps } = await fixture();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let disconnected!: () => void;
    const serverClosed = new Promise<void>(resolve => { disconnected = resolve; });
    app.post("/api/agents/:agentId/slow", async (_request, reply) => {
      reply.raw.once("close", disconnected);
      started(); await gate;
      if (outcome === "throw") throw new Error("handler failed");
      if (outcome === "reply") return reply.send({});
    });
    let client: http.ClientRequest | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const options = { hostname: "127.0.0.1", port: address.port, method: "POST", headers, path: `/api/agents/${agentId}/slow` };
      client = http.request(options);
      client.on("error", () => undefined);
      client.end();
      await entered;
      const closed = new Promise<void>(resolve => { client!.once("close", () => { resolve(); }); });
      client.destroy();
      await closed;
      await serverClosed;
      let nextEntered = false;
      const next = deps.slots.exclusive(agentId, async () => { nextEntered = true; });
      await Promise.resolve();
      expect(nextEntered).toBe(false);
      finish();
      await vi.waitFor(() => expect(nextEntered).toBe(true), { timeout: 2000 });
      await next;
      await new Promise<void>((resolve, reject) => {
        const request = http.request({ ...options, path: `/api/agents/${agentId}/tasks`, headers: { ...headers, "content-type": "application/json" } }, response => {
          response.resume();
          response.once("end", () => { try { expect(response.statusCode).toBe(200); resolve(); } catch (error) { reject(error); } });
        });
        request.on("error", reject);
        request.setTimeout(2000, () => { request.destroy(new Error("Agent lock stayed held")); });
        request.end(JSON.stringify({ prompt: "Next mutation" }));
      });
    } finally { finish(); client?.destroy(); await app.close(); }
  });
});
