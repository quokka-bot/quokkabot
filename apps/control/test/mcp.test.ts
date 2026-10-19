import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit.js";
import { ClaudeStreamParser } from "../src/claude-adapter.js";
import type { Connectors } from "../src/connectors.js";
import type { Db } from "../src/db.js";
import { McpEndpoint } from "../src/mcp.js";
import type { TaskRow } from "../src/tasks.js";

describe("Gmail tool privacy", () => {
  it("stores text digests in the audit and only lengths in task tool events", async () => {
    const rows: Record<string, unknown>[] = [];
    let head: { seq: number; hash: string } | null = null;
    const pool = { connect: async () => ({ query: pool.query.bind(pool), release: () => undefined }), query: async (sql: string, values: unknown[]) => {
      if (["BEGIN", "COMMIT", "ROLLBACK", "select pg_advisory_xact_lock(hashtextextended($1, 1))"].includes(sql)) return { rows: [] };
      if (sql === "select fenced_at, fence_reason from runs where id = $1") return { rows: [{ fenced_at: null, fence_reason: null }] };
      if (sql === "select seq, hash from audit_heads where agent_id = $1") return { rows: head ? [head] : [] };
      if (sql === "select audit_append($1, $2, $3, $4, $5, $6, $7, $8)") {
        rows.push({ type: values[4], data: JSON.parse(String(values[5])) });
        head = { seq: Number(values[1]), hash: String(values[7]) };
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    } } as unknown as Db;
    const audit = new AuditLog(pool, Buffer.alloc(32, 8));
    const connectors = {
      gmailAccount: async () => "owner@example.test",
      gmailCreateDraft: async () => "draft-id",
      gmailSearch: async () => "No messages match.",
    } as unknown as Connectors;
    const mcp = new McpEndpoint(pool, {} as never, {} as never, audit, {} as never, {} as never, {} as never, () => { throw new Error("unused"); }, {} as never, {} as never, connectors, pino({ level: "silent" }), () => "http://10.231.1.3:8090/mcp");
    const marker = "distinctive-private-mail";
    const calls = [
      { name: "gmail_create_draft", input: { to: [`${marker}@example.test`], cc: [`copy-${marker}@example.test`], subject: `${marker} subject`, body: `${marker} body` } },
      { name: "gmail_search", input: { query: `${marker} query`, max_results: 5 } },
    ];
    const parser = new ClaudeStreamParser();
    for (const { name, input } of calls) {
      const outcome = await mcp.call({ agentId: "agent", runId: "run", task: { id: "task" } as TaskRow }, name, input);
      expect(outcome.status).toBe("ok");
      const events = parser.parseLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name: `mcp__quokkabot__${name}`, input }] } })).events;
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(marker);
      const called = rows.find((row) => row.type === "tool.called" && (row.data as { tool: string }).tool === name);
      const stored = (called?.data as { input: Record<string, unknown> }).input;
      for (const [key, value] of Object.entries(input)) {
        if (typeof value === "number") continue;
        expect(stored[key]).toEqual(audit.textDigest(typeof value === "string" ? value : JSON.stringify(value)));
      }
    }
    expect(JSON.stringify(rows)).not.toContain(marker);
  });
});

describe("MCP slot listener authentication", () => {
  it.each([
    ["10.231.1.3", true], ["::ffff:10.231.1.3", true], ["10.231.2.3", false], [undefined, false],
  ])("requires the run's slot address on the socket: %s", async (localAddress, allowed) => {
    const get = vi.fn(async () => ({ id: "task" }));
    const db = { query: vi.fn(async () => ({ rows: [{ id: "run", task_id: "task", agent_id: "agent-1" }] })) } as unknown as Db;
    const mcp = new McpEndpoint(db, { get } as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      () => { throw new Error("unused"); }, {} as never, {} as never, {} as never, pino({ level: "silent" }),
      agentId => agentId === "agent-1" ? "http://10.231.1.3:8090/mcp" : null);
    const request = { headers: { authorization: `Bearer ${"a".repeat(40)}`, host: "10.231.1.3:8090", "x-forwarded-host": "10.231.1.3" }, socket: { localAddress } };
    const authenticated = await (mcp as unknown as { authenticate: (request: unknown) => Promise<unknown> }).authenticate(request);
    expect(authenticated !== null).toBe(allowed);
    expect(get).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
  it("rejects a run whose slot is no longer configured", async () => {
    const db = { query: async () => ({ rows: [{ id: "run", task_id: "task", agent_id: "removed-slot" }] }) } as unknown as Db;
    const mcp = new McpEndpoint(db, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      () => { throw new Error("unused"); }, {} as never, {} as never, {} as never, pino({ level: "silent" }), () => null);
    const request = { headers: { authorization: `Bearer ${"a".repeat(40)}` }, socket: { localAddress: "10.231.1.3" } };
    expect(await (mcp as unknown as { authenticate: (request: unknown) => Promise<unknown> }).authenticate(request)).toBeNull();
  });
});

describe("MCP removal drain", () => {
  it("waits for in-flight calls before allowing data deletion", async () => {
    let release!: (value: unknown) => void;
    const exec = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const db = { query: async () => ({ rows: [{ fenced_at: null, fence_reason: null }] }) } as unknown as Db;
    const audit = { append: async () => undefined, textDigest: () => ({ hmac: "test", length: 0 }) } as unknown as AuditLog;
    const mcp = new McpEndpoint(db, {} as never, {} as never, audit, { exec } as never, {} as never, {} as never,
      () => { throw new Error("unused"); }, {} as never, {} as never, {} as never, pino({ level: "silent" }), () => null);
    const call = mcp.call({ agentId: "agent", runId: "run", task: { id: "task" } as TaskRow }, "workspace_exec", { command: "pwd", cwd: "", timeout_s: 10 });
    await vi.waitFor(() => expect(exec).toHaveBeenCalled());
    let drained = false;
    const drain = mcp.drainAgent("agent").then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release({ exitCode: 0, timedOut: false, truncated: false, stdout: "", stderr: "" });
    await call;
    await drain;
    expect(drained).toBe(true);
    await mcp.drainAgent("agent");
  });
});
