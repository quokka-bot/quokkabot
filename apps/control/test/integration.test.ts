// End-to-end test of the control plane with a real PostgreSQL (Docker) and fake supervisor, egress, browser
// service and Selkies. The test plays the CLI: it calls the MCP endpoint with the run's token, then feeds the run's
// stream-json output through the fake supervisor. Runs only with QB_INTEGRATION=1 (needs Docker).
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@quokkabot/shared/node";
import { AI_PROVIDERS, REACTION_EMOJIS, type TaskEvent, type TaskEventEnvelope } from "@quokkabot/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";
import pino from "pino";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ControlHandles, startControl } from "../src/app.js";
import { Auth, killCapability } from "../src/auth.js";
import { AuditLog } from "../src/audit.js";
import { newPairingCode, pairingCodeHash } from "../src/pairing.js";
import { SoftPasskey } from "./soft-passkey.js";
import { parseTotp, totpCode } from "../src/vault.js";
import type { ControlConfig } from "../src/config.js";
import { TaskEvents } from "../src/events.js";

const enabled = process.env.QB_INTEGRATION === "1";
const AGENT = "6f1c1d2e-8f4b-4c55-9a59-0d7a7f6f3a10";
const AGENT2 = "7f1c1d2e-8f4b-4c55-9a59-0d7a7f6f3a10";
const secret = (): string => randomBytes(24).toString("base64url");
const SUMMARY_BYTES = Buffer.from("October invoice saved: invoice-1002.pdf\n");

interface FakeRun {
  runId: string;
  request: Record<string, unknown>;
  lines: { n: number; stream: "stdout" | "stderr"; line: string }[];
  state: "running" | "exited" | "cancelled";
  exitCode: number | null;
}

function listen(server: http.Server, target: number | string): Promise<number> {
  return new Promise((resolve) => {
    server.listen(target, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function body(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : null;
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

describe.skipIf(!enabled)("control plane end to end", () => {
  let container = "";
  let control: ControlHandles;
  let appPort = 0;
  let mcpPort = 0;
  const runs = new Map<string, FakeRun>();
  const browserCommands: Record<string, unknown>[] = [];
  const secretFills: Record<string, unknown>[] = [];
  // What the fake browser service answers to the next fill; null answers "ok".
  let secretFillRefusal: string | null = null;
  const leases: Record<string, unknown>[] = [];
  const selkiesTables: Record<string, unknown>[] = [];
  const policies: Record<string, unknown>[] = [];
  const supervisorCalls: string[] = [];
  // The fake supervisor's stored Claude sign-in: which sign-in made it and when.
  let claudeToken: { id: string; at: string } | null = null;
  const workspaceImages = new Map<string, Buffer>();
  let egressFrozen = 0;
  const sessionToken = secret();
  let db: pg.Pool;
  let killSecret: Buffer;
  let passkey: SoftPasskey;
  let controlConfig: ControlConfig;
  const googleClient = { clientId: "integration-google-client", clientSecret: "integration-google-secret" };
  const googleRequests: { url: URL; method: string; body: string; authorization: string | null }[] = [];
  let restoreFetch: (() => void) | undefined;

  beforeAll(async () => {
    const realFetch = globalThis.fetch;
    // MCP, egress and browser calls share fetch with the connector, so intercept only Google's two API hosts.
    const googleFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "oauth2.googleapis.com" && url.hostname !== "gmail.googleapis.com") return realFetch(input, init);
      const request = new Request(input, init);
      const requestBody = await request.text();
      googleRequests.push({ url, method: request.method, body: requestBody, authorization: request.headers.get("authorization") });
      if (url.href === "https://oauth2.googleapis.com/token") {
        const params = new URLSearchParams(requestBody);
        if (params.get("grant_type") === "authorization_code") return Response.json({
          refresh_token: "fake-google-refresh", access_token: "fake-exchange-access", expires_in: 3600,
          scope: "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
          id_token: `header.${Buffer.from(JSON.stringify({ email: "Owner@Example.TEST", email_verified: true })).toString("base64url")}.signature`,
        });
        if (params.get("grant_type") === "refresh_token") return Response.json({ access_token: "fake-gmail-access", expires_in: 3600 });
      }
      if (url.href === "https://oauth2.googleapis.com/revoke") return new Response(null, { status: 200 });
      if (url.pathname === "/gmail/v1/users/me/messages" && request.method === "GET") return Response.json({});
      if (url.href === "https://gmail.googleapis.com/gmail/v1/users/me/drafts" && request.method === "POST") {
        return Response.json({ id: "draft-integration-1", message: { id: "message-integration-1" } });
      }
      throw new Error(`Unexpected Google request: ${request.method} ${url.href}`);
    });
    restoreFetch = () => googleFetch.mockRestore();
    const ownerPassword = secret();
    container = execFileSync("docker", [
      "run", "-d", "--rm", "-e", "POSTGRES_USER=quokkabot_owner", "-e", `POSTGRES_PASSWORD=${ownerPassword}`,
      "-e", "POSTGRES_DB=quokkabot", "-p", "127.0.0.1::5432", "postgres:17-alpine",
    ]).toString().trim();
    const dbPort = Number(execFileSync("docker", ["port", container, "5432/tcp"]).toString().trim().split(":").at(-1));
    for (let i = 0; i < 60; i += 1) {
      try {
        execFileSync("docker", ["exec", container, "pg_isready", "-U", "quokkabot_owner", "-d", "quokkabot"], { stdio: "ignore" });
        const probe = new pg.Client({ host: "127.0.0.1", port: dbPort, user: "quokkabot_owner", password: ownerPassword, database: "quokkabot" });
        await probe.connect();
        await probe.end();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Fake supervisor on a unix socket.
    const socketDir = mkdtempSync(join(tmpdir(), "qb-sup-"));
    const socketPath = join(socketDir, "s.sock");
    const supervisorToken = secret();
    const supervisor = http.createServer((req, res) => {
      void (async () => {
        if (req.headers.authorization !== `Bearer ${supervisorToken}`) return json(res, 401, {});
        const url = new URL(req.url ?? "/", "http://x");
        supervisorCalls.push(`${req.method} ${url.pathname}`);
        const p = url.pathname;
        if (p.endsWith("/computer") && req.method === "GET") {
          return json(res, 200, {
            agentId: AGENT, killed: false, killedAt: null,
            sandboxes: ["cli", "tools", "browser"].map((name) => ({ name, container: `qb-${name}-1`, state: "running", runtime: "runsc", startedAt: new Date().toISOString(), memoryBytes: 1 })),
          });
        }
        if (/\/computer\/(start|stop|unlatch)$/.test(p) || p.endsWith("/tools/reset") || p.endsWith("/wipe") || /\/runs\/[^/]+\/cleanup$/.test(p)) return json(res, 200, {});
        if (p.endsWith("/computer/kill")) return json(res, 200, { agentId: AGENT, killed: true, killedAt: new Date().toISOString(), sandboxes: [] });
        if (p === `/v1/agents/${AGENT}/claude-sign-in` && req.method === "POST") {
          await body(req);
          return json(res, 200, { signInId: randomUUID(), url: "https://claude.com/cai/oauth/authorize?code=true&state=integration" });
        }
        const signInMatch = /^\/v1\/claude-sign-in\/([^/]+)(\/code)?$/.exec(p);
        if (signInMatch?.[2] && req.method === "POST") {
          await body(req);
          claudeToken = { id: signInMatch[1]!, at: new Date().toISOString() };
          return json(res, 200, { signedIn: true, signedInAt: claudeToken.at });
        }
        if (signInMatch && req.method === "DELETE") return json(res, 200, { ok: true });
        const tokenMatch = /^\/v1\/claude-token(?:\/([^/]+))?$/.exec(p);
        if (tokenMatch && req.method === "DELETE") {
          const removed = claudeToken !== null && (tokenMatch[1] === undefined || tokenMatch[1] === claudeToken.id);
          if (removed) claudeToken = null;
          return json(res, 200, { removed });
        }
        if (p === `/v1/agents/${AGENT}/workspace-file` && req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          workspaceImages.set(url.searchParams.get("path") ?? "", Buffer.concat(chunks));
          return json(res, 200, { ok: true });
        }
        if (p === `/v1/agents/${AGENT}/runs` && req.method === "POST") {
          const request = (await body(req)) as Record<string, unknown>;
          const runId = String(request.runId);
          runs.set(runId, { runId, request, lines: [], state: "running", exitCode: null });
          return json(res, 202, status(runs.get(runId)!));
        }
        const runMatch = /^\/v1\/runs\/([^/]+)(\/output|\/cancel)?$/.exec(p);
        if (runMatch?.[1]) {
          const run = runs.get(runMatch[1]);
          if (!run) return json(res, 404, {});
          if (runMatch[2] === "/cancel") {
            run.state = "cancelled";
            return json(res, 200, {});
          }
          if (runMatch[2] === "/output") {
            const from = Number(url.searchParams.get("from") ?? "0");
            const deadline = Date.now() + 1000;
            while (Date.now() < deadline && run.lines.filter((l) => l.n >= from).length === 0) await new Promise((r) => setTimeout(r, 50));
            res.writeHead(200, { "content-type": "application/x-ndjson" });
            return res.end(run.lines.filter((l) => l.n >= from).map((l) => JSON.stringify(l)).join("\n"));
          }
          return json(res, 200, status(run));
        }
        if (p.endsWith("/files/export")) {
          await body(req);
          res.writeHead(200, { "content-type": "application/octet-stream" });
          return res.end(SUMMARY_BYTES);
        }
        if (p.endsWith("/files")) {
          const request = (await body(req)) as { op: string };
          if (request.op === "stat") return json(res, 200, { op: "stat", entry: { name: "summary.txt", path: "summary.txt", type: "file", bytes: SUMMARY_BYTES.length, modifiedAt: new Date().toISOString() }, sha256: sha256Hex(SUMMARY_BYTES) });
          return json(res, 200, { op: "error", code: "invalid", message: "not in this fake" });
        }
        return json(res, 404, { path: p });
      })();
    });
    function status(run: FakeRun): Record<string, unknown> {
      return { runId: run.runId, agentId: AGENT, state: run.state, exitCode: run.exitCode, startedAt: new Date().toISOString(), endedAt: run.state === "running" ? null : new Date().toISOString(), lines: run.lines.length, lastOutputAt: null };
    }
    await listen(supervisor, socketPath);

    // Fake egress control API.
    const egressToken = secret();
    const egress = http.createServer((req, res) => {
      void (async () => {
        if (req.headers.authorization !== `Bearer ${egressToken}`) return json(res, 401, {});
        if (req.url === "/v1/policy") {
          policies.push((await body(req)) as Record<string, unknown>);
          return json(res, 200, {});
        }
        if (req.url?.startsWith("/v1/decisions")) {
          await new Promise((r) => setTimeout(r, 200));
          return json(res, 200, { epoch: "test-epoch-1", events: [] });
        }
        if (req.url?.endsWith("/freeze")) {
          egressFrozen += 1;
          return json(res, 200, { closed: 0 });
        }
        return json(res, 404, {});
      })();
    });
    const egressPort = await listen(egress, 0);

    // Fake browser service and Selkies.
    const browserToken = secret();
    const browser = http.createServer((req, res) => {
      void (async () => {
        if (req.headers.authorization !== `Bearer ${browserToken}`) return json(res, 401, {});
        if (req.url === "/health") return json(res, 200, { chrome: "up" });
        if (req.url === "/v1/control-lease") {
          leases.push((await body(req)) as Record<string, unknown>);
          return json(res, 200, {});
        }
        if (req.url === "/v1/commands") {
          const command = (await body(req)) as Record<string, unknown>;
          browserCommands.push(command);
          return json(res, 200, { commandId: command.commandId, status: "ok", tab: "t1", url: "https://example.com/", title: "Example" });
        }
        if (req.url === "/v1/secret-fill") {
          const fill = (await body(req)) as Record<string, unknown>;
          secretFills.push(fill);
          if (secretFillRefusal !== null) return json(res, 200, { commandId: fill.commandId, status: "blocked", message: secretFillRefusal });
          return json(res, 200, { commandId: fill.commandId, status: "ok" });
        }
        if (req.url?.startsWith("/v1/downloads")) return json(res, 200, { downloads: [] });
        return json(res, 404, {});
      })();
    });
    const browserPort = await listen(browser, 0);
    const selkiesMaster = secret();
    const selkies = http.createServer((req, res) => {
      void (async () => {
        if (req.headers.authorization !== `Bearer ${selkiesMaster}`) return json(res, 401, {});
        if (req.method === "GET") return json(res, 200, {});
        selkiesTables.push((await body(req)) as Record<string, unknown>);
        return json(res, 200, {});
      })();
    });
    // The live view: answers the upgrade and keeps the socket open, as Selkies does while a viewer watches.
    selkies.on("upgrade", (req, socket) => {
      const accept = createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    const selkiesPort = await listen(selkies, 0);

    appPort = 20000 + Math.floor(Math.random() * 20000);
    mcpPort = appPort + 1;
    const downloadsDir = mkdtempSync(join(tmpdir(), "qb-dl-"));
    const config: ControlConfig = {
      appOrigin: `http://localhost:${appPort}`,
      viewOrigin: `http://view.localhost:${appPort}`,
      appHost: `localhost:${appPort}`,
      viewHost: `view.localhost:${appPort}`,
      ownerName: "Owner",
      appleAppIds: ["ABCDE12345.com.example.quokkabot"],
      dataRoot: "/data",
      secretsDir: "/run/secrets",
      listen: `127.0.0.1:${appPort}`,
      database: { host: "127.0.0.1", port: dbPort, name: "quokkabot", ownerUser: "quokkabot_owner", appUser: "quokkabot_app" },
      supervisorSocket: socketPath,
      egressUrl: `http://127.0.0.1:${egressPort}`,
      agents: [{
        agentId: AGENT as never, index: 1, name: "Agent 1", mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
        browserServiceUrl: `http://127.0.0.1:${browserPort}`, selkiesUrl: `http://127.0.0.1:${selkiesPort}`, downloadsDir,
      }, {
        agentId: AGENT2 as never, index: 2, name: "Agent 2", mcpUrl: `http://127.0.0.2:${mcpPort}/mcp`,
        browserServiceUrl: `http://127.0.0.1:${browserPort}`, selkiesUrl: `http://127.0.0.1:${selkiesPort}`,
        downloadsDir: mkdtempSync(join(tmpdir(), "qb-dl2-")),
      }],
      defaultModel: "claude-opus-5-5",
      defaultEffort: "xhigh",
      aiConsentRequired: false,
      secrets: {
        dbOwnerPassword: ownerPassword, dbAppPassword: secret(), sessionSecret: (killSecret = Buffer.from(secret())), auditHmacKey: Buffer.from(secret()),
        vaultKey: randomBytes(32), googleClient, supervisorToken, egressToken, perAgent: new Map([AGENT, AGENT2].map(id => [id, { selkiesMasterToken: selkiesMaster, browserServiceToken: browserToken }])),
      },
    };
    controlConfig = config;
    // Site requests wait 6 seconds for the owner here, not 90.
    control = await startControl(config, pino({ level: "warn" }), mkdtempSync(join(tmpdir(), "qb-web-")), 6_000);
    db = new pg.Pool({ host: "127.0.0.1", port: dbPort, user: "quokkabot_app", password: config.secrets.dbAppPassword, database: "quokkabot" });
    // Sign the owner in directly; passkey ceremonies are covered elsewhere.
    await db.query("insert into sessions (hash, expires_at, fresh_until) values ($1, now() + interval '1 day', now() + interval '5 minutes')", [sha256Hex(sessionToken)]);
    passkey = new SoftPasskey("localhost", `http://localhost:${appPort}`);
    await passkey.register(db);
    // The owner, as setup records it with the first passkey.
    await db.query("insert into owner_account (id, name, webauthn_user_id) values (1, 'Owner', $1) on conflict do nothing", [randomBytes(32).toString("base64url")]);
  }, 120_000);

  afterAll(async () => {
    try {
      await control?.close();
      await db?.end();
      if (container) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    } finally {
      restoreFetch?.();
    }
  });

  // node:http, not fetch: fetch drops a custom Host header, and the server routes by Host.
  function api(method: string, path: string, payload?: unknown, opts: { origin?: string | null; cookie?: boolean; extraCookie?: string; response?: "text"; headers?: Record<string, string>; host?: string } = {}): Promise<{ status: number; body: any; setCookie: string[]; headers: http.IncomingHttpHeaders }> {
    const headers: Record<string, string> = { host: opts.host ?? `localhost:${appPort}`, ...opts.headers };
    const cookies = [opts.cookie !== false ? `qb_session=${sessionToken}` : "", opts.extraCookie ?? ""].filter(Boolean);
    if (cookies.length > 0) headers.cookie = cookies.join("; ");
    const origin = opts.origin === undefined ? `http://localhost:${appPort}` : opts.origin;
    if (origin) headers.origin = origin;
    const data = payload === undefined ? null : Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    if (data !== null) {
      headers["content-type"] = Buffer.isBuffer(payload) ? (opts.headers?.["content-type"] ?? "application/octet-stream") : "application/json";
      headers["content-length"] = String(Buffer.byteLength(data));
    }
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: appPort, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode ?? 0, body: text ? (opts.response === "text" ? text : JSON.parse(text)) : null, setCookie: res.headers["set-cookie"] ?? [], headers: res.headers });
        });
      });
      req.on("error", reject);
      req.end(data ?? undefined);
    });
  }

  async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, what: string, ms = 15_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value !== undefined && value !== false) return value as T;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async function mcpClient(token: string): Promise<Client> {
    const client = new Client({ name: "fake-cli", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never);
    return client;
  }

  function emit(run: FakeRun, value: unknown): void {
    run.lines.push({ n: run.lines.length, stream: "stdout", line: JSON.stringify(value) });
  }

  function textOf(result: unknown): string {
    const content = (result as { content: { type: string; text?: string }[] }).content;
    return content.map((c) => c.text ?? "").join("\n");
  }

  it("refuses state changes from another origin and without a session", async () => {
    expect((await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "x" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "x" }, { origin: null })).status).toBe(403);
    expect((await api("GET", "/api/agents", undefined, { cookie: false })).status).toBe(401);
  });

  it("runs a task through a question, a resume and an attached result", async () => {
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Download the October invoice from the billing portal." });
    expect(created.status).toBe(200);
    const taskId = created.body.id as string;

    const run1 = await waitFor(() => [...runs.values()][0], "first run");
    expect(run1.request).toMatchObject({ resume: false, model: "claude-opus-5-5", effort: "xhigh" });
    expect(String(run1.request.prompt)).toContain("October invoice");
    const lease = await waitFor(() => leases.at(-1), "lease");
    expect(lease).toMatchObject({ holder: "agent" });
    expect(selkiesTables.at(-1)).toHaveProperty("agent-lock");

    const cli = await mcpClient(String(run1.request.mcpToken));
    const tools = await cli.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("browser_open");
    expect(tools.tools.map((t) => t.name).join(",")).not.toMatch(/eval|cookie/);

    const opened = await cli.callTool({ name: "browser_open", arguments: { url: "https://example.com/" } });
    expect(textOf(opened)).toContain("status: ok");
    expect(browserCommands.at(-1)).toMatchObject({ op: { op: "open", url: "https://example.com/" }, generation: lease.generation });

    const invalid = await cli.callTool({ name: "browser_open", arguments: { url: "file:///etc/passwd" } });
    expect(textOf(invalid)).toContain("status: invalid");
    const extra = await cli.callTool({ name: "browser_tabs", arguments: { anything: 1 } });
    expect(textOf(extra)).toContain("status: invalid");

    const asked = await cli.callTool({ name: "ask_owner", arguments: { question: "Which account: personal or company?" } });
    expect(textOf(asked)).toContain("End your turn");
    const fenced = await cli.callTool({ name: "browser_tabs", arguments: {} });
    expect(textOf(fenced)).toContain("status: blocked");
    await cli.close();

    emit(run1, { type: "system", subtype: "init", session_id: "s", mcp_servers: [{ name: "quokkabot", status: "connected" }] });
    emit(run1, { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "I asked which account to use." }] } });
    emit(run1, { type: "result", subtype: "success", is_error: false, result: "Waiting for the owner.", session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } });
    run1.state = "exited";
    run1.exitCode = 0;

    const blocked = await waitFor(async () => {
      const detail = await api("GET", `/api/tasks/${taskId}`);
      const ended = detail.body.runs[0]?.state === "exited";
      return detail.body.task.blockedReason === "waiting_for_owner" && ended ? detail.body : undefined;
    }, "task blocked on the owner with its run ended");
    expect(blocked.task.state).toBe("running");
    const inbox = await api("GET", "/api/inbox");
    expect(inbox.body.items).toHaveLength(1);

    // A token from a finished run is useless.
    const stale = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: "POST", headers: { authorization: `Bearer ${String(run1.request.mcpToken)}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(stale.status).toBe(401);

    expect((await api("POST", `/api/tasks/${taskId}/reply`, { text: "Company." })).status).toBe(200);
    const run2 = await waitFor(() => [...runs.values()][1], "second run");
    expect(run2.request).toMatchObject({ resume: true, sessionId: run1.request.sessionId });
    expect(String(run2.request.prompt)).toContain("Company.");

    const cli2 = await mcpClient(String(run2.request.mcpToken));
    const attached = await cli2.callTool({ name: "attach_result", arguments: { workspace_paths: ["summary.txt"], summary: "Saved the October invoice." } });
    expect(textOf(attached)).toContain("Attached 1 file");
    await cli2.close();
    emit(run2, { type: "result", subtype: "success", is_error: false, result: "Done: October invoice saved.", session_id: "s", usage: { input_tokens: 1, output_tokens: 1 } });
    run2.state = "exited";
    run2.exitCode = 0;

    const done = await waitFor(async () => {
      const detail = await api("GET", `/api/tasks/${taskId}`);
      return detail.body.task.state === "completed" ? detail.body : undefined;
    }, "task completed");
    expect(done.task.result.summary).toBe("Saved the October invoice.");
    expect(done.task.result.files[0]).toMatchObject({ name: "summary.txt", scope: "workspace" });
    // Cleanup of the CLI transcript follows the completed state.
    await waitFor(() => supervisorCalls.some((c) => c.endsWith("/cleanup")), "session cleanup");

    // A follow-up starts a new CLI session (the old transcript is gone) carrying the request and the result.
    expect((await api("POST", `/api/tasks/${taskId}/message`, { text: "Also get November." })).status).toBe(200);
    const run3 = await waitFor(() => [...runs.values()][2], "follow-up run");
    expect(run3.request.resume).toBe(false);
    expect(run3.request.sessionId).not.toBe(run1.request.sessionId);
    expect(String(run3.request.prompt)).toContain("October invoice");
    expect(String(run3.request.prompt)).toContain("Saved the October invoice.");
    expect(String(run3.request.prompt)).toContain("Also get November.");
    emit(run3, { type: "result", subtype: "success", is_error: false, result: "November saved.", session_id: "s3", usage: { input_tokens: 1, output_tokens: 1 } });
    run3.state = "exited";
    run3.exitCode = 0;
    await waitFor(async () => ((await api("GET", `/api/tasks/${taskId}`)).body.task.state === "completed" ? true : undefined), "follow-up completed");

    const verify = await api("GET", `/api/agents/${AGENT}/audit/verify`);
    expect(verify.body).toMatchObject({ ok: true });
    expect(verify.body.count).toBeGreaterThan(10);
  }, 60_000);

  it("keeps an answer given while the asking run is still shutting down", async () => {
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Find the Hetzner invoice." });
    const before = runs.size;
    const run = await waitFor(() => [...runs.values()][before], "run");
    const cli = await mcpClient(String(run.request.mcpToken));
    await cli.callTool({ name: "ask_owner", arguments: { question: "Which month?" } });
    await cli.close();
    // Answer first, then let the fenced CLI end its turn.
    expect((await api("POST", `/api/tasks/${created.body.id}/reply`, { text: "September." })).status).toBe(200);
    emit(run, { type: "result", subtype: "success", is_error: false, result: "Asked.", session_id: "r", usage: { input_tokens: 1, output_tokens: 1 } });
    run.state = "exited";
    run.exitCode = 0;
    const next = await waitFor(() => [...runs.values()][before + 1], "run with the answer");
    expect(String(next.request.prompt)).toContain("September.");
    emit(next, { type: "result", subtype: "success", is_error: false, result: "Found it.", session_id: "r", usage: { input_tokens: 1, output_tokens: 1 } });
    next.state = "exited";
    next.exitCode = 0;
    await waitFor(async () => ((await api("GET", `/api/tasks/${created.body.id}`)).body.task.state === "completed" ? true : undefined), "completed");
  }, 30_000);

  it("never starts a task while the owner holds the browser, and audits the hand-back", async () => {
    expect((await api("POST", `/api/agents/${AGENT}/takeover`, { action: "take" })).body).toMatchObject({ holder: "owner" });
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Check the billing page." });
    expect(created.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(runs.size).toBe(before);
    expect((await api("POST", `/api/agents/${AGENT}/takeover`, { action: "return" })).body).toMatchObject({ holder: "paused" });
    const run = await waitFor(() => [...runs.values()][before], "run after hand-back");
    await waitFor(() => (leases.at(-1)?.holder === "agent" ? true : undefined), "agent lease");
    const audit = await api("GET", `/api/agents/${AGENT}/audit`);
    expect(audit.body.events.some((e: { type: string }) => e.type === "takeover.ended")).toBe(true);
    emit(run, { type: "result", subtype: "success", is_error: false, result: "Checked.", session_id: "s4", usage: { input_tokens: 1, output_tokens: 1 } });
    run.state = "exited";
    run.exitCode = 0;
    await waitFor(async () => ((await api("GET", `/api/tasks/${created.body.id}`)).body.task.state === "completed" ? true : undefined), "task completed");
  }, 30_000);

  it("signs in with a saved login: the vault types the values, the model and the audit log never see them", async () => {
    const password = `pw-${secret()}`;
    const totpSecret = "JBSWY3DPEHPK3PXP";
    const saved = await api("POST", `/api/agents/${AGENT}/logins`, {
      name: "Roblox", sites: ["roblox.com", "*.roblox.com"], username: "game-owner", password, totp: totpSecret,
    });
    expect(saved.status).toBe(200);
    // A login belongs to the site with its subdomains, as in a password manager.
    expect(saved.body).toMatchObject({ name: "Roblox", sites: ["*.roblox.com"], username: "game-owner", passwordLength: password.length, hasTotp: true });
    const suffixOnly = await api("POST", `/api/agents/${AGENT}/logins`, { name: "Everything", sites: ["*.co.uk"], username: "x", password: "y" });
    expect(suffixOnly.status).toBe(400);
    expect(JSON.stringify(saved.body)).not.toContain(password);
    const loginId = saved.body.id as string;
    const listed = await api("GET", `/api/agents/${AGENT}/logins`);
    expect(JSON.stringify(listed.body)).not.toContain(password);
    expect(JSON.stringify(listed.body)).not.toContain(totpSecret);
    // Stored encrypted: neither value appears in the row.
    const raw = await db.query("select * from logins where id = $1", [loginId]);
    expect(JSON.stringify(raw.rows[0])).not.toContain(password);
    expect(raw.rows[0].password_enc.includes(Buffer.from(password))).toBe(false);

    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Download the Roblox payout report." });
    const run = await waitFor(() => [...runs.values()][before], "run");
    const cli = await mcpClient(String(run.request.mcpToken));
    const list = textOf(await cli.callTool({ name: "logins_list", arguments: {} }));
    expect(list).toContain(loginId);
    expect(list).toContain("2FA code available");
    expect(list).not.toContain(password);

    const filled = textOf(await cli.callTool({ name: "browser_fill_login", arguments: { tab: "t1", snapshot: 1, ref: "e3", login_id: loginId, field: "password", submit: true } }));
    expect(filled).toContain("status: ok");
    expect(filled).not.toContain(password);
    expect(secretFills.at(-1)).toMatchObject({ kind: "password", value: password, allowedPatterns: ["*.roblox.com"], submit: true, tab: "t1", ref: "e3" });

    const code = textOf(await cli.callTool({ name: "browser_fill_code", arguments: { tab: "t1", snapshot: 2, ref: "e7", login_id: loginId } }));
    expect(code).toContain("status: ok");
    const typed = String(secretFills.at(-1)?.value);
    const spec = parseTotp(totpSecret);
    expect([totpCode(spec, Date.now() - 30_000), totpCode(spec), totpCode(spec, Date.now() + 30_000)]).toContain(typed);
    expect(code).not.toContain(typed);

    // A login the agent has is never requested from the owner.
    const again = textOf(await cli.callTool({ name: "request_login", arguments: { site: "www.roblox.com", name: "Roblox", reason: "Sign in" } }));
    expect(again).toContain("status: invalid");
    expect(again).toContain(loginId);
    // Another agent's login id, or a made-up one, types nothing.
    const unknown = textOf(await cli.callTool({ name: "browser_fill_login", arguments: { tab: "t1", snapshot: 2, ref: "e3", login_id: "00000000-0000-4000-8000-000000000000", field: "password" } }));
    expect(unknown).toContain("status: invalid");

    // No login for the site: the task waits for the owner, and saving one resumes it with the login's id.
    const asked = textOf(await cli.callTool({ name: "request_login", arguments: { site: "creator.roblox.dev", name: "Creator Hub", reason: "The payout report is behind this sign-in." } }));
    expect(asked).toContain("End your turn");
    await cli.close();
    emit(run, { type: "result", subtype: "success", is_error: false, result: "Waiting for a login.", session_id: "l", usage: { input_tokens: 1, output_tokens: 1 } });
    run.state = "exited";
    run.exitCode = 0;
    await waitFor(async () => {
      const detail = await api("GET", `/api/tasks/${created.body.id}`);
      return detail.body.task.blockedReason === "waiting_for_owner" && detail.body.runs[0]?.state === "exited" ? true : undefined;
    }, "task waiting for the login");
    const inbox = await api("GET", "/api/inbox");
    const card = inbox.body.items.find((i: { request?: { kind: string } }) => i.request?.kind === "login");
    expect(card.request).toMatchObject({ kind: "login", site: "roblox.dev", loginName: "Creator Hub" });

    const second = await api("POST", `/api/agents/${AGENT}/logins`, { name: "Creator Hub", sites: ["creator.roblox.dev"], username: "game-owner", password: `pw-${secret()}` });
    expect(second.status).toBe(200);
    const next = await waitFor(() => [...runs.values()][before + 1], "run after the login was saved");
    expect(String(next.request.prompt)).toContain(second.body.id);
    expect(String(next.request.prompt)).toContain("browser_fill_login");
    emit(next, { type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "l", usage: { input_tokens: 1, output_tokens: 1 } });
    next.state = "exited";
    next.exitCode = 0;
    await waitFor(async () => ((await api("GET", `/api/tasks/${created.body.id}`)).body.task.state === "completed" ? true : undefined), "completed");

    // The audit log records the use, never the value.
    const audit = await api("GET", `/api/agents/${AGENT}/audit`);
    const text = JSON.stringify(audit.body);
    expect(text).toContain("login.used");
    expect(text).not.toContain(password);
    expect(text).not.toContain(typed);
    expect((await api("GET", `/api/agents/${AGENT}/audit/verify`)).body).toMatchObject({ ok: true });

    // Changing the password keeps the id; removing the login removes it.
    const changed = await api("PUT", `/api/logins/${loginId}`, { password: "new-password-1" });
    expect(changed.body).toMatchObject({ id: loginId, passwordLength: 14 });
    expect((await api("DELETE", `/api/logins/${loginId}`)).status).toBe(200);
    expect((await api("GET", `/api/agents/${AGENT}/logins`)).body.logins.some((l: { id: string }) => l.id === loginId)).toBe(false);
  }, 45_000);

  async function finishRun(run: FakeRun, text: string): Promise<void> {
    emit(run, { type: "result", subtype: "success", is_error: false, result: text, session_id: "x", usage: { input_tokens: 1, output_tokens: 1 } });
    run.state = "exited";
    run.exitCode = 0;
  }

  it("connects Gmail from an owner request, resumes the task, creates a draft and disconnects", async () => {
    expect((await api("GET", `/api/agents/${AGENT}/connectors`)).body).toEqual({ connectors: [], available: { gmail: true } });
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Find the invoice in Gmail and draft a reply." });
    expect(created.status).toBe(200);
    const taskId = created.body.id as string;
    const run = await waitFor(() => [...runs.values()][before], "run needing Gmail");
    const privacyMarker = "private-mail-regression-7c2d";
    const draftInput = { to: [`${privacyMarker}@example.test`], cc: [`copy-${privacyMarker}@example.test`], subject: `Spalio sąskaita ${privacyMarker}`, body: `Thank you for the invoice.\n${privacyMarker}` };
    const cli = await mcpClient(String(run.request.mcpToken));
    try {
      for (const tool of [
        { name: "gmail_search", arguments: { query: "subject:invoice", max_results: 5 } },
        { name: "gmail_read", arguments: { message_id: "msg001" } },
        { name: "gmail_create_draft", arguments: draftInput },
      ]) {
        const blocked = textOf(await cli.callTool(tool));
        expect(blocked).toContain("status: blocked");
        expect(blocked).toContain("request_connection");
      }
      expect(googleRequests).toEqual([]);
      const asked = textOf(await cli.callTool({ name: "request_connection", arguments: { app: "gmail", reason: "Find the invoice and draft a reply." } }));
      expect(asked).toContain("status: ok");
      expect(asked).toContain("End your turn");
      expect(textOf(await cli.callTool({ name: "gmail_search", arguments: {} }))).toContain("status: blocked");
    } finally {
      await cli.close();
    }
    const waiting = await api("GET", `/api/tasks/${taskId}`);
    expect(waiting.body.task).toMatchObject({ state: "running", blockedReason: "waiting_for_owner" });
    const inbox = await api("GET", "/api/inbox");
    const card = inbox.body.items.find((item: { request?: { taskId: string } }) => item.request?.taskId === taskId);
    expect(card?.request).toMatchObject({ taskId, runId: run.runId, kind: "connect", connector: "gmail", text: "Find the invoice and draft a reply.", answeredAt: null });
    const requestId = card.request.id as string;
    await finishRun(run, "Waiting for Gmail.");
    await waitFor(async () => {
      const detail = await api("GET", `/api/tasks/${taskId}`);
      return detail.body.task.blockedReason === "waiting_for_owner" && detail.body.runs[0]?.state === "exited" ? true : undefined;
    }, "task waiting for Gmail with its run ended");

    const started = await api("POST", `/api/agents/${AGENT}/connectors/gmail/start`, {});
    expect(started.status).toBe(200);
    const consent = new URL(started.body.url as string);
    expect(consent.origin + consent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(consent.searchParams.get("client_id")).toBe(googleClient.clientId);
    expect(consent.searchParams.get("redirect_uri")).toBe(`http://localhost:${appPort}/api/connect/google/callback`);
    const state = consent.searchParams.get("state");
    if (!state) throw new Error("Google URL has no state");
    const callback = await api("GET", `/api/connect/google/callback?${new URLSearchParams({ state, code: "fake-authorization-code" })}`, undefined, { cookie: false, origin: null, response: "text" });
    expect(callback.status).toBe(200);
    expect(callback.body).toContain("Gmail connected");
    expect(callback.body).toContain("owner@example.test");
    const exchange = googleRequests[0];
    expect(exchange?.url.href).toBe("https://oauth2.googleapis.com/token");
    expect(exchange?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(exchange?.body))).toEqual({
      grant_type: "authorization_code", code: "fake-authorization-code", redirect_uri: `http://localhost:${appPort}/api/connect/google/callback`,
      client_id: googleClient.clientId, client_secret: googleClient.clientSecret,
    });
    const listed = await api("GET", `/api/agents/${AGENT}/connectors`);
    expect(listed.status).toBe(200);
    expect(listed.body.connectors).toHaveLength(1);
    expect(listed.body.connectors[0]).toMatchObject({ agentId: AGENT, app: "gmail", account: "owner@example.test" });
    expect(JSON.stringify(listed.body)).not.toContain("fake-google-refresh");
    const connectorId = listed.body.connectors[0].id as string;
    const stored = await db.query<{ refresh_enc: Buffer }>("select refresh_enc from connectors where id = $1", [connectorId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.refresh_enc.includes(Buffer.from("fake-google-refresh"))).toBe(false);
    const answered = await db.query("select answered_at, answer from owner_requests where id = $1", [requestId]);
    expect(answered.rows[0]).toMatchObject({ answered_at: expect.any(Date), answer: "Connected owner@example.test" });
    expect((await api("GET", "/api/inbox")).body.items.some((item: { request?: { id: string } }) => item.request?.id === requestId)).toBe(false);

    const next = await waitFor(() => [...runs.values()][before + 1], "run after Gmail connected");
    expect(next.request).toMatchObject({ resume: true, sessionId: run.request.sessionId });
    expect(String(next.request.prompt)).toContain("The owner connected Gmail (owner@example.test)");
    expect(String(next.request.prompt)).toContain("gmail_create_draft");
    expect((await api("GET", `/api/tasks/${taskId}`)).body.task).toMatchObject({ state: "running", blockedReason: null });
    const cli2 = await mcpClient(String(next.request.mcpToken));
    try {
      const draft = textOf(await cli2.callTool({ name: "gmail_create_draft", arguments: draftInput }));
      expect(draft).toContain("status: ok");
      expect(draft).toContain("draft-integration-1");
      expect(draft).toContain("not sent");
      const refreshRequest = googleRequests[1];
      expect(refreshRequest?.url.href).toBe("https://oauth2.googleapis.com/token");
      expect(Object.fromEntries(new URLSearchParams(refreshRequest?.body))).toEqual({
        grant_type: "refresh_token", refresh_token: "fake-google-refresh", client_id: googleClient.clientId, client_secret: googleClient.clientSecret,
      });
      const gmailRequest = googleRequests[2];
      expect(gmailRequest).toMatchObject({ method: "POST", authorization: "Bearer fake-gmail-access" });
      expect(gmailRequest?.url.href).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
      const payload = JSON.parse(gmailRequest!.body) as { message: { raw: string } };
      const mime = Buffer.from(payload.message.raw, "base64url").toString("utf8");
      expect(mime).toContain(`To: ${draftInput.to[0]}\r\nCc: ${draftInput.cc[0]}\r\nSubject: =?UTF-8?B?`);
      expect(Buffer.from(mime.split("\r\n\r\n")[1]!, "base64").toString("utf8")).toBe(draftInput.body);
      const searchInput = { query: `${privacyMarker} query`, max_results: 5 };
      expect(textOf(await cli2.callTool({ name: "gmail_search", arguments: searchInput }))).toContain("status: ok");
      emit(next, { type: "assistant", message: { content: [
        { type: "tool_use", id: "draft-privacy", name: "mcp__quokkabot__gmail_create_draft", input: draftInput },
        { type: "tool_use", id: "search-privacy", name: "mcp__quokkabot__gmail_search", input: searchInput },
      ] } });
      await waitFor(async () => {
        const events = await db.query("select event from task_events where task_id = $1 and event->>'kind' = 'tool_call'", [taskId]);
        return events.rows.length === 2 ? true : undefined;
      }, "private Gmail tool summaries");
      expect(JSON.stringify((await db.query("select event from task_events where task_id = $1", [taskId])).rows)).not.toContain(privacyMarker);
      expect(JSON.stringify((await db.query("select data from audit_events where agent_id = $1", [AGENT])).rows)).not.toContain(privacyMarker);
      const duplicate = textOf(await cli2.callTool({ name: "request_connection", arguments: { app: "gmail", reason: "Connect again." } }));
      expect(duplicate).toContain("status: invalid");
      expect(duplicate).toContain("already connected (owner@example.test)");
    } finally {
      await cli2.close();
    }
    const requests = await db.query("select id from owner_requests where task_id = $1 and kind = 'connect'", [taskId]);
    expect(requests.rows).toHaveLength(1);
    await finishRun(next, "Saved a draft for the owner.");
    await waitFor(async () => ((await api("GET", `/api/tasks/${taskId}`)).body.task.state === "completed" ? true : undefined), "Gmail task completed");
    expect((await api("DELETE", `/api/connectors/${connectorId}`)).status).toBe(200);
    expect((await api("GET", `/api/agents/${AGENT}/connectors`)).body.connectors).toEqual([]);
    expect((await db.query("select id from connectors where id = $1", [connectorId])).rows).toEqual([]);
    expect(googleRequests.at(-1)?.url.href).toBe("https://oauth2.googleapis.com/revoke");
    expect(googleRequests.at(-1)?.method).toBe("POST");
    expect(new URLSearchParams(googleRequests.at(-1)?.body).get("token")).toBe("fake-google-refresh");
    expect((await api("GET", `/api/agents/${AGENT}/audit/verify`)).body).toMatchObject({ ok: true });
  }, 45_000);

  it("resolves a connection completed between the first account check and request insertion exactly once", async () => {
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Find the invoice after connecting Gmail." });
    expect(created.status).toBe(200);
    const taskId = created.body.id as string;
    const run = await waitFor(() => [...runs.values()][before], "connection race run");
    const started = await api("POST", `/api/agents/${AGENT}/connectors/gmail/start`, {});
    const state = new URL(started.body.url).searchParams.get("state");
    if (!state) throw new Error("Google consent has no state");
    const originalFence = control.tasks.fence.bind(control.tasks);
    const fence = vi.spyOn(control.tasks, "fence").mockImplementationOnce(async (id, reason) => {
      await originalFence(id, reason);
      // requestConnection already saw no account, but has not inserted its card yet.
      expect((await db.query("select id from owner_requests where task_id = $1", [taskId])).rows).toEqual([]);
      const connected = await api("GET", `/api/connect/google/callback?${new URLSearchParams({ state, code: "racing-code" })}`, undefined, { cookie: false, response: "text" });
      expect(connected.body).toContain("Gmail connected");
      expect((await db.query("select id from owner_requests where task_id = $1", [taskId])).rows).toEqual([]);
    });
    const cli = await mcpClient(String(run.request.mcpToken));
    try {
      expect(textOf(await cli.callTool({ name: "request_connection", arguments: { app: "gmail", reason: "Find the invoice." } }))).toContain("status: ok");
      expect(fence).toHaveBeenCalledOnce();
    } finally {
      fence.mockRestore();
      await cli.close();
    }
    const detail = await api("GET", `/api/tasks/${taskId}`);
    expect(detail.body.openRequests).toEqual([]);
    expect(detail.body.task.blockedReason).toBeNull();
    const requests = await db.query<{ id: string; answered_at: Date }>("select id, answered_at from owner_requests where task_id = $1", [taskId]);
    expect(requests.rows).toEqual([{ id: expect.any(String), answered_at: expect.any(Date) }]);
    // Repeated notifications and the insertion recheck all share the same claim path.
    await Promise.all([
      control.tasks.connectorConnected(AGENT, "gmail", "owner@example.test"),
      control.tasks.connectorConnected(AGENT, "gmail", "owner@example.test"),
    ]);
    const messages = await db.query("select event from task_events where task_id = $1 and event->>'kind' = 'owner_message'", [taskId]);
    expect(messages.rows).toHaveLength(2);
    const audits = await db.query("select data from audit_events where agent_id = $1 and type = 'owner_request.answered' and data->>'requestId' = $2", [AGENT, requests.rows[0]!.id]);
    expect(audits.rows).toHaveLength(1);
    await finishRun(run, "Asked for Gmail.");
    const next = await waitFor(() => [...runs.values()][before + 1], "resumed connection race run");
    expect(String(next.request.prompt)).toContain("The owner connected Gmail");
    await finishRun(next, "Invoice checked.");
    await waitFor(async () => ((await api("GET", `/api/tasks/${taskId}`)).body.task.state === "completed" ? true : undefined), "connection race completed");
    const listed = await api("GET", `/api/agents/${AGENT}/connectors`);
    expect((await api("DELETE", `/api/connectors/${listed.body.connectors[0].id}`)).status).toBe(200);
  }, 45_000);

  it("returns an owner-held lease when a question reply also resolves an open takeover", async () => {
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Check the invoice with the owner's help." });
    const taskId = created.body.id as string;
    const run = await waitFor(() => [...runs.values()][before], "mixed request run");
    const cli = await mcpClient(String(run.request.mcpToken));
    try {
      expect(textOf(await cli.callTool({ name: "ask_owner", arguments: { question: "Which month?" } }))).toContain("status: ok");
    } finally {
      await cli.close();
    }
    // Model parallel calls can leave several cards; the question is preferred for the resumed prompt.
    await db.query("insert into owner_requests (id, task_id, run_id, kind, text, what_to_do) values ($1, $2, $3, 'takeover', 'Check the portal', 'Confirm the invoice')", [randomUUID(), taskId, run.runId]);
    expect((await api("POST", `/api/agents/${AGENT}/takeover`, { action: "take" })).body.holder).toBe("owner");
    const response = await api("POST", `/api/tasks/${taskId}/reply`, { text: "October, continue." });
    expect(response.status).toBe(200);
    expect((await control.computer.lease(AGENT)).holder).toBe("paused");
    expect((await api("GET", `/api/tasks/${taskId}`)).body.openRequests).toEqual([]);
    const answered = await db.query("select answer from owner_requests where task_id = $1 and answered_at is not null", [taskId]);
    expect(answered.rows).toEqual([{ answer: "October, continue." }, { answer: "October, continue." }]);
    await finishRun(run, "Asked.");
    const next = await waitFor(() => [...runs.values()][before + 1], "mixed request resumed");
    expect(String(next.request.prompt)).toContain("The owner answered your question");
    expect(String(next.request.prompt)).toContain("October, continue.");
    await finishRun(next, "Checked.");
    await waitFor(async () => ((await api("GET", `/api/tasks/${taskId}`)).body.task.state === "completed" ? true : undefined), "mixed request completed");
  }, 45_000);

  it("atomically accepts one concurrent reply and emits just one owner message", async () => {
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Check the billing month." });
    const taskId = created.body.id as string;
    const run = await waitFor(() => [...runs.values()][before], "concurrent reply run");
    const cli = await mcpClient(String(run.request.mcpToken));
    try {
      expect(textOf(await cli.callTool({ name: "ask_owner", arguments: { question: "Which month?" } }))).toContain("status: ok");
    } finally {
      await cli.close();
    }
    const cursor = (await api("GET", `/api/tasks/${taskId}`)).body.lastSeq as number;
    // Hold the request lock until the first UPDATE has reached PostgreSQL. The agent lock queues the second reply
    // behind the first in control, so only one can be waiting on the row at a time.
    const gate = await db.connect();
    let replies: ReturnType<typeof api>[] = [];
    try {
      await gate.query("BEGIN");
      await gate.query("select id from owner_requests where task_id = $1 and answered_at is null for update", [taskId]);
      replies = ["October", "November"].map((text) => api("POST", `/api/tasks/${taskId}/reply`, { text }));
      await waitFor(async () => {
        const blocked = await db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like 'update owner_requests set answered_at = now(), answer = $2 where task_id = $1%'");
        return blocked.rows[0]!.n === 1 ? true : undefined;
      }, "a reply blocked on the open request");
    } finally {
      await gate.query("COMMIT");
      gate.release();
    }
    const results = await Promise.all(replies);
    expect(results.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(results.find((reply) => reply.status === 409)?.body.error.code).toBe("no_question");
    const stream = await new TaskEvents(db).after(taskId, cursor);
    const ownerMessages = stream.filter((envelope) => envelope.event.kind === "owner_message");
    expect(ownerMessages).toHaveLength(1);
    expect(stream).toHaveLength(2);
    const winner = (ownerMessages[0]!.event as Extract<TaskEvent, { kind: "owner_message" }>).text;
    const answered = await db.query("select answer from owner_requests where task_id = $1", [taskId]);
    expect(answered.rows).toEqual([{ answer: winner }]);
    const request = await db.query<{ id: string }>("select id from owner_requests where task_id = $1", [taskId]);
    expect((await db.query("select seq from audit_events where type = 'owner_request.answered' and data->>'requestId' = $1", [request.rows[0]!.id])).rows).toHaveLength(1);
    await finishRun(run, "Asked.");
    const next = await waitFor(() => [...runs.values()][before + 1], "single reply resumed run");
    expect(String(next.request.prompt)).toContain(winner);
    await finishRun(next, "Checked.");
    await waitFor(async () => ((await api("GET", `/api/tasks/${taskId}`)).body.task.state === "completed" ? true : undefined), "concurrent reply completed");
  }, 45_000);

  it("deduplicates task creation keys for ten minutes, including concurrent HTTP requests", async () => {
    // Keep tasks queued so dispatch cannot obscure the transaction assertions.
    expect((await api("POST", `/api/agents/${AGENT}/takeover`, { action: "take" })).body.holder).toBe("owner");
    const ids = new Set<string>();
    const key = `create-${secret()}`;
    const headers = { "Idempotency-Key": key };
    try {
      const results = await Promise.all([
        api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Collect invoices once." }, { headers }),
        api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Retry must preserve the first task." }, { headers }),
      ]);
      for (const result of results) expect(result.status).toBe(200);
      expect(results[0]!.body.id).toBe(results[1]!.body.id);
      const id = results[0]!.body.id as string;
      ids.add(id);
      expect((await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Another retry." }, { headers })).body.id).toBe(id);
      expect((await db.query("select event from task_events where task_id = $1 and event->>'kind' = 'owner_message'", [id])).rows).toHaveLength(1);
      expect((await db.query("select seq from audit_events where type = 'task.created' and data->>'taskId' = $1", [id])).rows).toHaveLength(1);
      const different = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "A separate request." }, { headers: { "Idempotency-Key": `${key}-different` } });
      expect(different.status).toBe(200);
      expect(different.body.id).not.toBe(id);
      ids.add(different.body.id);
      // Simulate the expiry without waiting ten minutes, using the same hashed header key.
      await db.query("update task_creation_keys set expires_at = now() - interval '1 second' where agent_id = $1 and key_hash = $2", [AGENT, sha256Hex(key)]);
      const expired = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "A new task after expiry." }, { headers });
      expect(expired.status).toBe(200);
      expect(expired.body.id).not.toBe(id);
      ids.add(expired.body.id);
      const unkeyed = await Promise.all([1, 2].map(() => api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Unkeyed creates are independent." })));
      expect(unkeyed[0]!.body.id).not.toBe(unkeyed[1]!.body.id);
      for (const result of unkeyed) { expect(result.status).toBe(200); ids.add(result.body.id); }
      expect((await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Invalid key." }, { headers: { "Idempotency-Key": "" } })).status).toBe(400);
    } finally {
      for (const id of ids) await api("POST", `/api/tasks/${id}/cancel`, {});
      await api("POST", `/api/agents/${AGENT}/takeover`, { action: "return" });
    }
  }, 30_000);

  it("sends a sign-in takeover back to the saved logins, fixes a rejected login and lets the owner sign in instead", async () => {
    const saved = await api("POST", `/api/agents/${AGENT}/logins`, { name: "Billing", sites: ["billing.example.com"], username: "owner", password: "old-password" });
    const loginId = saved.body.id as string;
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Get the invoice from the billing portal." });
    const run = await waitFor(() => [...runs.values()][before], "run");
    const cli = await mcpClient(String(run.request.mcpToken));
    // A takeover for a sign-in before any saved login was tried is refused with the way to do it.
    const takeover = textOf(await cli.callTool({ name: "request_takeover", arguments: { reason: "Need to sign in", what_to_do: "Log in to the billing portal" } }));
    expect(takeover).toContain("status: invalid");
    expect(takeover).toContain("browser_fill_login");
    // The saved login was tried and the site rejected it: the agent asks the owner to fix that login.
    expect(textOf(await cli.callTool({ name: "browser_fill_login", arguments: { tab: "t1", snapshot: 1, ref: "e2", login_id: loginId, field: "password", submit: true } }))).toContain("status: ok");
    const repair = textOf(await cli.callTool({ name: "request_login", arguments: { site: "billing.example.com", name: "Billing", reason: "The saved password was rejected.", login_id: loginId, problem: "Incorrect password" } }));
    expect(repair).toContain("End your turn");
    await cli.close();
    await finishRun(run, "Waiting for the owner.");
    const card = await waitFor(async () => (await api("GET", "/api/inbox")).body.items.find((i: { request?: { loginId?: string } }) => i.request?.loginId === loginId), "repair card");
    expect(card.request.text).toContain("Incorrect password");
    expect((await api("PUT", `/api/logins/${loginId}`, { password: "new-password" })).status).toBe(200);
    const next = await waitFor(() => [...runs.values()][before + 1], "run after the fix");
    expect(String(next.request.prompt)).toContain("updated the login");

    // Now a site with no saved login, and the owner signs in themselves.
    const cli2 = await mcpClient(String(next.request.mcpToken));
    expect(textOf(await cli2.callTool({ name: "request_login", arguments: { site: "portal.example.org", name: "Portal", reason: "Sign in to download" } }))).toContain("End your turn");
    await cli2.close();
    await finishRun(next, "Waiting for a login.");
    const loginCard = await waitFor(async () => (await api("GET", "/api/inbox")).body.items.find((i: { request?: { site?: string } }) => i.request?.site === "example.org"), "login card");
    expect((await api("POST", `/api/owner-requests/${loginCard.request.id}/sign-in-myself`, {})).status).toBe(200);
    const asTakeover = await waitFor(async () => (await api("GET", "/api/inbox")).body.items.find((i: { request?: { id: string; kind: string } }) => i.request?.id === loginCard.request.id && i.request?.kind === "takeover"), "takeover card");
    expect(asTakeover.request.whatToDo).toContain("example.org");
    await waitFor(async () => ((await api("GET", `/api/tasks/${created.body.id}`)).body.runs.every((r: { state: string }) => r.state !== "running") ? true : undefined), "runs ended");
    expect((await api("POST", `/api/tasks/${created.body.id}/takeover-done`, { note: "" })).status).toBe(200);
    const third = await waitFor(() => [...runs.values()][before + 2], "run after the owner signed in");
    expect(String(third.request.prompt)).toContain("finished the takeover");
    await finishRun(third, "Done.");
    await waitFor(async () => ((await api("GET", `/api/tasks/${created.body.id}`)).body.task.state === "completed" ? true : undefined), "completed");
    await api("DELETE", `/api/logins/${loginId}`);
  }, 60_000);

  it("asks the owner to allow a saved login on another site and resumes once they do", async () => {
    const saved = await api("POST", `/api/agents/${AGENT}/logins`, { name: "Outlook", sites: ["outlook.com"], username: "owner", password: `pw-${secret()}` });
    const loginId = saved.body.id as string;
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Read the latest Outlook mail." });
    const run = await waitFor(() => [...runs.values()][before], "run");
    const cli = await mcpClient(String(run.request.mcpToken));
    secretFillRefusal = "wrong site: the field is on login.live.com";
    let refused: string;
    try {
      refused = textOf(await cli.callTool({ name: "browser_fill_login", arguments: { tab: "t1", snapshot: 1, ref: "e2", login_id: loginId, field: "username" } }));
    } finally {
      secretFillRefusal = null;
    }
    expect(refused).toContain("status: blocked");
    expect(refused).toContain("login.live.com");
    expect(refused).toContain("outlook.com");
    expect(refused).toContain(`request_login with login_id ${loginId}`);
    const asked = textOf(await cli.callTool({ name: "request_login", arguments: { site: "login.live.com", name: "Outlook", reason: "Outlook signs in on live.com.", login_id: loginId, problem: "wrong site" } }));
    expect(asked).toContain('Asked the owner to allow "Outlook" on live.com');
    await cli.close();
    await finishRun(run, "Waiting for the owner.");
    const card = await waitFor(async () => (await api("GET", "/api/inbox")).body.items.find((i: { request?: { loginId?: string } }) => i.request?.loginId === loginId), "allow card");
    expect(card.request).toMatchObject({ kind: "login", site: "live.com", loginName: "Outlook" });
    // The card's one click: the login's sites plus the new one.
    const allowed = await api("PUT", `/api/logins/${loginId}`, { sites: [...(saved.body.sites as string[]), card.request.site] });
    expect(allowed.body.sites).toEqual(["*.outlook.com", "*.live.com"]);
    const next = await waitFor(() => [...runs.values()][before + 1], "run after the site was allowed");
    expect(String(next.request.prompt)).toContain("updated the login");
    await finishRun(next, "Read it.");
    await waitFor(async () => ((await api("GET", `/api/tasks/${created.body.id}`)).body.task.state === "completed" ? true : undefined), "completed");
    await api("DELETE", `/api/logins/${loginId}`);
  }, 30_000);

  it("keeps a login saved while the asking run is still shutting down", async () => {
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Check the store payouts." });
    const run = await waitFor(() => [...runs.values()][before], "run");
    const cli = await mcpClient(String(run.request.mcpToken));
    expect(textOf(await cli.callTool({ name: "request_login", arguments: { site: "store.example.net", name: "Store", reason: "Payouts need a sign-in" } }))).toContain("End your turn");
    await cli.close();
    // Saved before the CLI ends its turn: the run's end must resume the task, not complete it.
    const saved = await api("POST", `/api/agents/${AGENT}/logins`, { name: "Store", sites: ["store.example.net"], username: "owner", password: `pw-${secret()}` });
    await finishRun(run, "Asked for a login.");
    const next = await waitFor(() => [...runs.values()][before + 1], "run with the login");
    expect(String(next.request.prompt)).toContain(saved.body.id);
    expect((await api("GET", `/api/tasks/${created.body.id}`)).body.task.state).toBe("running");
    await finishRun(next, "Payouts checked.");
    await waitFor(async () => ((await api("GET", `/api/tasks/${created.body.id}`)).body.task.state === "completed" ? true : undefined), "completed");
    await api("DELETE", `/api/logins/${saved.body.id}`);
  }, 30_000);

  async function approveWithPasskey(userCode: string): Promise<void> {
    const options = await api("POST", "/api/desktop-link/approve/options", { userCode });
    expect(options.status).toBe(200);
    const challengeCookie = options.setCookie.find((c) => c.startsWith("qb_challenge="))!.split(";")[0]!;
    const verified = await api("POST", "/api/desktop-link/approve/verify", { userCode, response: passkey.assert(options.body) }, { extraCookie: challengeCookie });
    expect(verified.status).toBe(200);
  }

  it("binds a link approval to an assertion made for that link", async () => {
    const a = await api("POST", "/api/desktop-link/start", { kind: "signin", deviceName: "A" }, { cookie: false });
    const b = await api("POST", "/api/desktop-link/start", { kind: "signin", deviceName: "B" }, { cookie: false });
    const optionsA = await api("POST", "/api/desktop-link/approve/options", { userCode: a.body.userCode });
    const cookieA = optionsA.setCookie.find((c) => c.startsWith("qb_challenge="))!.split(";")[0]!;
    // An assertion for link A cannot approve link B.
    const wrong = await api("POST", "/api/desktop-link/approve/verify", { userCode: b.body.userCode, response: passkey.assert(optionsA.body) }, { extraCookie: cookieA });
    expect(wrong.status).toBe(403);
    expect((await api("POST", "/api/desktop-link/poll", { pollToken: b.body.pollToken }, { cookie: false })).status).toBe(202);
    // A fresh-auth challenge is not a link approval either.
    const freshOptions = await api("POST", "/api/auth/fresh/options", {});
    const freshCookie = freshOptions.setCookie.find((c) => c.startsWith("qb_challenge="))!.split(";")[0]!;
    const crossed = await api("POST", "/api/desktop-link/approve/verify", { userCode: a.body.userCode, response: passkey.assert(freshOptions.body) }, { extraCookie: freshCookie });
    expect(crossed.status).toBe(403);
  });

  it("signs the desktop app in through the browser, and re-checks it the same way", async () => {
    const info = await api("GET", "/api/desktop/info", undefined, { cookie: false });
    expect(info.body).toMatchObject({ product: "quokkabot", apiVersion: 1, appOrigin: `http://localhost:${appPort}`, minDesktopVersion: expect.any(String) });
    const started = await api("POST", "/api/desktop-link/start", { kind: "signin", deviceName: "Test Mac" }, { cookie: false });
    expect(started.status).toBe(200);
    expect(started.body.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.body.verifyUrl).toBe(`http://localhost:${appPort}/link#${started.body.userCode}`);
    const pollToken = started.body.pollToken as string;
    expect((await api("POST", "/api/desktop-link/poll", { pollToken }, { cookie: false })).status).toBe(202);
    // The browser (signed in, fresh) sees the device and approves.
    const pending = await api("GET", `/api/desktop-link/pending?code=${started.body.userCode}`);
    expect(pending.body).toMatchObject({ kind: "signin", deviceName: "Test Mac" });
    // A fresh browser session alone does not approve: only a passkey assertion made for this link.
    expect((await api("POST", "/api/desktop-link/approve", { userCode: started.body.userCode })).status).toBe(404);
    await approveWithPasskey(started.body.userCode);
    const approved = await api("POST", "/api/desktop-link/poll", { pollToken }, { cookie: false });
    expect(approved.body).toEqual({ state: "approved" });
    const sessionCookie = approved.setCookie.find((c) => c.startsWith("qb_session="));
    expect(sessionCookie).toBeDefined();
    expect(approved.setCookie.some((c) => c.startsWith("qb_kill="))).toBe(true);
    const desktopToken = sessionCookie!.split(";")[0]!.slice("qb_session=".length);
    const me = await api("GET", "/api/me", undefined, { cookie: false, extraCookie: `qb_session=${desktopToken}` });
    expect(me.status).toBe(200);
    // Collected once only.
    expect((await api("POST", "/api/desktop-link/poll", { pollToken }, { cookie: false })).status).toBe(410);
    const devices = await api("GET", "/api/sessions");
    expect(devices.body.sessions).toContainEqual(expect.objectContaining({ deviceName: "Test Mac", client: "desktop" }));

    // Fresh re-check for the desktop session through the browser.
    await db.query("update sessions set fresh_until = null where hash = $1", [sha256Hex(desktopToken)]);
    const fresh = await api("POST", "/api/desktop-link/start", { kind: "fresh", deviceName: "Test Mac" }, { cookie: false, extraCookie: `qb_session=${desktopToken}` });
    expect(fresh.status).toBe(200);
    await approveWithPasskey(fresh.body.userCode);
    expect((await api("POST", "/api/desktop-link/poll", { pollToken: fresh.body.pollToken }, { cookie: false })).body).toEqual({ state: "approved" });
    const meFresh = await api("GET", "/api/me", undefined, { cookie: false, extraCookie: `qb_session=${desktopToken}` });
    expect(meFresh.body.freshUntil).not.toBeNull();

    // Refused links and revoked devices.
    const refused = await api("POST", "/api/desktop-link/start", { kind: "signin", deviceName: "Someone else" }, { cookie: false });
    expect((await api("POST", "/api/desktop-link/refuse", { userCode: refused.body.userCode })).status).toBe(200);
    expect((await api("POST", "/api/desktop-link/poll", { pollToken: refused.body.pollToken }, { cookie: false })).body).toEqual({ state: "refused" });
    const device = devices.body.sessions.find((d: { deviceName: string }) => d.deviceName === "Test Mac");
    expect((await api("DELETE", `/api/sessions/${device.id}`)).status).toBe(200);
    expect((await api("GET", "/api/me", undefined, { cookie: false, extraCookie: `qb_session=${desktopToken}` })).status).toBe(401);
    // A fresh re-check needs a signed-in requester.
    expect((await api("POST", "/api/desktop-link/start", { kind: "fresh", deviceName: "x" }, { cookie: false })).status).toBe(401);
  });

  it("lists recently finished tasks for desktop notifications", async () => {
    // Without a cursor: the current position, no history.
    const head = await api("GET", "/api/activity");
    expect(head.body).toMatchObject({ items: [], more: false });
    // From the beginning: every finished task, in order, paged.
    const all = await api("GET", `/api/activity?cursor=${encodeURIComponent(`${new Date(0).toISOString()}|00000000-0000-0000-0000-000000000000`)}`);
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThan(0);
    expect(all.body.items[0]).toMatchObject({ state: expect.stringMatching(/completed|failed|outcome_unknown|cancelled/) });
    const after = await api("GET", `/api/activity?cursor=${encodeURIComponent(all.body.cursor)}`);
    expect(after.body.items).toEqual([]);
    expect((await api("GET", "/api/activity?cursor=garbage")).status).toBe(400);
  });

  it("stores, streams and audits owner and agent reactions, validating targets and emoji", async () => {
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Collect invoices for reactions." });
    expect(created.status).toBe(200);
    const taskId = created.body.id as string;
    const run = await waitFor(() => [...runs.values()][before], "reaction run");
    const cli = await mcpClient(String(run.request.mcpToken));
    const events = new TaskEvents(db);
    const path = (seq: number | string, id = taskId) => `/api/tasks/${id}/events/${seq}/reaction`;
    const stored = async () => (await db.query<{ seq: number; by: string; emoji: string }>('select seq, "by", emoji from message_reactions where task_id = $1 order by seq, "by"', [taskId])).rows;
    const reactions = async () => (await db.query<{ event: TaskEvent }>("select event from task_events where task_id = $1 and event->>'kind' = 'reaction' order by seq", [taskId])).rows.map(row => row.event);
    const live: TaskEventEnvelope[] = [];
    let streamBuffer = "";
    const stream = http.get({
      host: "127.0.0.1", port: appPort, path: `/api/tasks/${taskId}/events?after=0`,
      headers: { host: `localhost:${appPort}`, cookie: `qb_session=${sessionToken}` },
    }, response => {
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        streamBuffer += chunk;
        const frames = streamBuffer.split("\n\n");
        streamBuffer = frames.pop()!;
        for (const frame of frames) {
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (data) live.push(JSON.parse(data.slice(6)) as TaskEventEnvelope);
        }
      });
    });
    try {
      await waitFor(() => live.some(envelope => envelope.event.kind === "owner_message") ? true : undefined, "initial SSE replay");
      expect((await cli.listTools()).tools.map(tool => tool.name)).toContain("react");
      expect(textOf(await cli.callTool({ name: "react", arguments: { emoji: "💥" } }))).toContain("status: invalid");
      expect(textOf(await cli.callTool({ name: "react", arguments: { emoji: "👍", targetSeq: 1 } }))).toContain("status: invalid");
      expect(await reactions()).toEqual([]);
      expect(textOf(await cli.callTool({ name: "react", arguments: { emoji: "👍" } }))).toContain("status: ok");
      expect(await stored()).toEqual([{ seq: 1, by: "agent", emoji: "👍" }]);
      await waitFor(() => live.some(envelope => envelope.event.kind === "reaction" && envelope.event.by === "agent") ? true : undefined, "live agent reaction");

      const latest = await events.append(db, taskId, { kind: "owner_message", text: "Thanks, include November.", attachments: [] });
      const other = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "A different task's owner message." });
      expect(other.status).toBe(200);
      expect((await api("POST", `/api/tasks/${other.body.id}/cancel`, {})).status).toBe(200);
      expect(textOf(await cli.callTool({ name: "react", arguments: { emoji: "👀" } }))).toContain("status: ok");
      expect(await stored()).toContainEqual({ seq: latest.seq, by: "agent", emoji: "👀" });
      expect(textOf(await cli.callTool({ name: "react", arguments: { emoji: null } }))).toContain("status: ok");
      expect(await stored()).toEqual([{ seq: 1, by: "agent", emoji: "👍" }]);

      const draft = await events.append(db, taskId, { kind: "assistant_delta", text: "Draft" });
      const final = await events.append(db, taskId, { kind: "assistant_text", text: "Invoice saved." });
      expect((await api("POST", path(final.seq), { emoji: "👍" }, { cookie: false })).status).toBe(401);
      expect((await api("POST", path(final.seq), { emoji: "👍" }, { origin: "https://evil.example" })).status).toBe(403);
      const invalidTargets = [1, 2, draft.seq];
      for (const seq of invalidTargets) {
        const invalid = await api("POST", path(seq), { emoji: "👍" });
        expect(invalid.status).toBe(400);
        expect(invalid.body.error.code).toBe("invalid_reaction_target");
      }
      expect((await api("POST", path(2_147_483_647), { emoji: "👍" })).status).toBe(404);
      expect((await api("POST", path(final.seq, other.body.id), { emoji: "👍" })).status).toBe(404);
      for (const seq of ["0", "-1", "1.5", "nope", "2147483648"]) expect((await api("POST", path(seq), { emoji: "👍" })).status).toBe(400);
      for (const body of [{ emoji: "💥" }, {}, { emoji: "" }, { emoji: "👍", by: "agent" }]) expect((await api("POST", path(final.seq), body)).status).toBe(400);
      expect(await stored()).toEqual([{ seq: 1, by: "agent", emoji: "👍" }]);
      expect(await reactions()).toHaveLength(3);
      for (const emoji of REACTION_EMOJIS) {
        expect((await api("POST", path(final.seq), { emoji })).status).toBe(200);
        expect(await stored()).toContainEqual({ seq: final.seq, by: "owner", emoji });
      }
      expect((await stored()).filter(row => row.by === "owner")).toHaveLength(1);
      expect((await api("POST", path(final.seq), { emoji: null })).status).toBe(200);
      expect(await stored()).toEqual([{ seq: 1, by: "agent", emoji: "👍" }]);

      await cli.callTool({ name: "ask_owner", arguments: { question: "Which month?" } });
      const question = await db.query<{ seq: number; event: Extract<TaskEvent, { kind: "owner_request" }> }>("select seq, event from task_events where task_id = $1 and event->>'kind' = 'owner_request' order by seq desc limit 1", [taskId]);
      const asked = question.rows[0];
      if (!asked) throw new Error("Question event was not recorded");
      expect((await api("POST", path(asked.seq), { emoji: "❤️" })).status).toBe(200);
      for (const kind of ["takeover", "login", "connect"] as const) {
        const request = await events.append(db, taskId, { kind: "owner_request", request: { ...asked.event.request, kind } });
        expect((await api("POST", path(request.seq), { emoji: "👍" })).status).toBe(400);
      }
      expect(textOf(await cli.callTool({ name: "react", arguments: { emoji: "👍" } }))).toContain("status: blocked");
      await waitFor(() => live.filter(envelope => envelope.event.kind === "reaction").length === 11 ? true : undefined, "all live reactions");
      expect(live.filter(envelope => envelope.event.kind === "reaction").map(envelope => envelope.event)).toEqual(await reactions());
      expect((await reactions()).at(-1)).toEqual({ kind: "reaction", targetSeq: asked.seq, by: "owner", emoji: "❤️" });
      const audit = await api("GET", `/api/agents/${AGENT}/audit`);
      const changes = audit.body.events.filter((event: { type: string; data: { taskId?: string } }) => event.type === "message.reaction_changed" && event.data.taskId === taskId);
      expect(changes).toHaveLength(11);
      expect(changes).toContainEqual(expect.objectContaining({ actor: "agent", data: { taskId, targetSeq: latest.seq, by: "agent", emoji: null } }));
      expect((await api("GET", `/api/agents/${AGENT}/audit/verify`)).body.ok).toBe(true);
    } finally {
      stream.destroy();
      await cli.close();
      await api("POST", `/api/tasks/${taskId}/cancel`, {});
    }
  }, 60_000);

  it("asks the owner for sites, not hosts, and allows each site with its subdomains", async () => {
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Read the Roblox creator stats." });
    expect(created.status).toBe(200);
    const taskId = created.body.id as string;
    const run = await waitFor(() => [...runs.values()][before], "site request run");
    const cli = await mcpClient(String(run.request.mcpToken));
    try {
      expect(textOf(await cli.callTool({ name: "request_domains", arguments: { domains: ["*.github.io"], reason: "Every tenant" } }))).toContain("status: invalid");
      const hosts = ["www.roblox.com", "auth.roblox.com", "apis.roblox.com", "css.rbxcdn.com", "js.rbxcdn.com", "roblox-api.arkoselabs.com"];
      const asked = cli.callTool({ name: "request_domains", arguments: { domains: hosts, reason: "Sign in to Roblox" } });
      const request = await waitFor(async () => (await db.query<{ id: string; domains: string[] }>("select id, domains from domain_requests where task_id = $1", [taskId])).rows[0], "site request");
      expect(request.domains).toEqual(["*.roblox.com", "*.rbxcdn.com", "*.arkoselabs.com"]);
      expect((await api("POST", `/api/domain-requests/${request.id}/decide`, { decision: "allow_task", attended: false })).status).toBe(200);
      expect(textOf(await asked)).toContain("Allowed: roblox.com, rbxcdn.com, arkoselabs.com, each with all its subdomains.");
      const rules = await db.query<{ pattern: string }>("select pattern from domain_rules where task_id = $1 order by pattern", [taskId]);
      expect(rules.rows.map(row => row.pattern)).toEqual(["*.arkoselabs.com", "*.rbxcdn.com", "*.roblox.com"]);

      // Writing instead of deciding skips the open request: the agent gets the message, the chat records the skip.
      const second = cli.callTool({ name: "request_domains", arguments: { domains: ["www.example.org"], reason: "Read the help page" } });
      const pending = await waitFor(async () => (await db.query<{ id: string }>("select id from domain_requests where task_id = $1 and decided_at is null", [taskId])).rows[0], "second site request");
      expect((await api("POST", `/api/tasks/${taskId}/reply`, { text: "Skip that, check Gmail.", attachmentIds: [] })).status).toBe(200);
      expect(textOf(await second)).toContain("The owner wrote you a message instead of allowing example.org.");
      expect((await db.query<{ decision: string }>("select decision from domain_requests where id = $1", [pending.id])).rows[0]?.decision).toBe("skip");
      expect((await db.query<{ pending_prompt: string }>("select pending_prompt from tasks where id = $1", [taskId])).rows[0]?.pending_prompt)
        .toBe("You asked the owner to allow example.org. Instead, the owner wrote:\nSkip that, check Gmail.");
      const stream = (await db.query<{ event: TaskEvent }>("select event from task_events where task_id = $1 order by seq", [taskId])).rows.map(row => row.event);
      expect(stream).toContainEqual({ kind: "domain_request", requestId: request.id, domains: ["*.roblox.com", "*.rbxcdn.com", "*.arkoselabs.com"], reason: "Sign in to Roblox" });
      expect(stream).toContainEqual({ kind: "domain_decided", requestId: request.id, decision: "allow_task", attended: false });
      expect(stream).toContainEqual({ kind: "domain_decided", requestId: pending.id, decision: "skip", attended: false });
      expect(stream.at(-2)).toEqual({ kind: "owner_message", text: "Skip that, check Gmail.", attachments: [] });
    } finally {
      await cli.close();
      await api("POST", `/api/tasks/${taskId}/cancel`, {});
    }
  }, 60_000);

  it("parks a run that ends with several open site requests and resumes the task once all are decided", async () => {
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Open two sites." });
    expect(created.status).toBe(200);
    const taskId = created.body.id as string;
    const run = await waitFor(() => [...runs.values()][before], "two site requests run");
    const blocked = async () => (await db.query<{ blocked_reason: string | null }>("select blocked_reason from tasks where id = $1", [taskId])).rows[0]?.blocked_reason;
    try {
      for (const site of ["*.one.example", "*.two.example"]) {
        await db.query("insert into domain_requests (id, agent_id, task_id, run_id, domains, reason) values (gen_random_uuid(), $1, $2, $3, $4, 'Two sites')", [AGENT, taskId, run.runId, [site]]);
      }
      await finishRun(run, "Waiting for the sites.");
      await waitFor(async () => (await blocked()) === "domain_request" ? true : undefined, "task parked on two site requests");
      const open = (await db.query<{ id: string }>("select id from domain_requests where task_id = $1 order by domains", [taskId])).rows.map(row => row.id);
      expect((await api("POST", `/api/domain-requests/${open[0]}/decide`, { decision: "refuse", attended: false })).status).toBe(200);
      expect(await blocked()).toBe("domain_request");
      expect((await api("POST", `/api/domain-requests/${open[1]}/decide`, { decision: "allow_task", attended: false })).status).toBe(200);
      await waitFor(() => runs.size > before + 1 ? true : undefined, "run resumed after the last decision");
    } finally {
      await api("POST", `/api/tasks/${taskId}/cancel`, {});
    }
  }, 60_000);

  it("keeps one open site request per task and resumes the agent on a decision that comes after the wait", async () => {
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Read the example docs." });
    expect(created.status).toBe(200);
    const taskId = created.body.id as string;
    const run = await waitFor(() => [...runs.values()][before], "site wait run");
    const cli = await mcpClient(String(run.request.mcpToken));
    const requests = async () => (await db.query<{ id: string; domains: string[]; decision: string | null }>(
      "select id, domains, decision from domain_requests where task_id = $1 order by created_at", [taskId])).rows;
    const cards = async () => (await db.query<{ event: TaskEvent }>(
      "select event from task_events where task_id = $1 and event->>'kind' = 'domain_request' order by seq", [taskId])).rows.map(row => row.event);
    try {
      // The agent asks for the same site twice, once by host and once by site, before the owner decides. The second
      // call also names a new site, which alone gets a new card.
      const first = cli.callTool({ name: "request_domains", arguments: { domains: ["docs.example.com"], reason: "Read the docs" } });
      await waitFor(async () => (await requests()).length === 1 ? true : undefined, "first site request");
      await new Promise((r) => setTimeout(r, 3_000));
      const second = cli.callTool({ name: "request_domains", arguments: { domains: ["example.com", "cdn.example.net"], reason: "Read the docs again" } });
      await waitFor(async () => (await requests()).length === 2 ? true : undefined, "second site request");
      expect(textOf(await first)).toContain("The owner has not decided yet. End your turn now; you continue when they decide.");
      expect(await requests()).toEqual([
        expect.objectContaining({ domains: ["*.example.com"], decision: null }),
        expect.objectContaining({ domains: ["*.example.net"], decision: null }),
      ]);
      expect((await cards()).map(card => (card as { domains: string[] }).domains)).toEqual([["*.example.com"], ["*.example.net"]]);
      const runRow = (await db.query<{ fence_reason: string | null }>("select fence_reason from runs where id = $1", [run.runId])).rows[0];
      expect(runRow?.fence_reason).toBe("domain_request");
      expect((await db.query<{ blocked_reason: string | null }>("select blocked_reason from tasks where id = $1", [taskId])).rows[0]?.blocked_reason).toBe("domain_request");
      // The parked run cannot ask again; the cards stay as they are.
      expect(textOf(await cli.callTool({ name: "request_domains", arguments: { domains: ["example.com"], reason: "Once more" } }))).toContain("You are waiting for the owner.");
      expect(await cards()).toHaveLength(2);

      // The owner decides both while the second call still waits and the run is ending its turn: the second call is
      // told to end its turn, and the decisions wait as the next prompt.
      const [open, cdn] = await requests();
      expect((await api("POST", `/api/domain-requests/${open?.id}/decide`, { decision: "allow_task", attended: false })).status).toBe(200);
      expect((await api("POST", `/api/domain-requests/${cdn?.id}/decide`, { decision: "refuse", attended: false })).status).toBe(200);
      expect(textOf(await second)).toContain("You are waiting for the owner. End your turn now; you continue when they decide.");
      const prompt = "Allowed: example.com, each with all its subdomains. The owner refused example.net. Find another way or tell the owner what you cannot do. Continue.";
      expect((await db.query<{ pending_prompt: string | null }>("select pending_prompt from tasks where id = $1", [taskId])).rows[0]?.pending_prompt).toBe(prompt);
      await finishRun(run, "Waiting for example.com.");
      const resumed = await waitFor(() => [...runs.values()][before + 1], "run resumed on the late decision");
      expect(String(resumed.request.prompt)).toContain(prompt);
      expect((await db.query<{ reported: boolean }>("select reported from domain_requests where id = $1", [open?.id])).rows[0]?.reported).toBe(true);
      expect((await db.query<{ state: string }>("select state from tasks where id = $1", [taskId])).rows[0]?.state).toBe("running");
    } finally {
      await cli.close();
      await api("POST", `/api/tasks/${taskId}/cancel`, {});
    }
  }, 60_000);

  it("asks again after a decision and never reuses another task's or another agent's site request", async () => {
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Open the shop." });
    expect(created.status).toBe(200);
    const taskId = created.body.id as string;
    const run = await waitFor(() => [...runs.values()][before], "reuse boundary run");
    const cli = await mcpClient(String(run.request.mcpToken));
    const earlierTask = randomUUID();
    const openFor = async (where: string, values: unknown[]) =>
      (await db.query<{ id: string }>(`select id from domain_requests where decided_at is null and ${where} order by created_at`, values)).rows;
    try {
      // Open requests for the same site from another task of this agent and from another agent (even naming this task).
      await db.query("insert into tasks (id, agent_id, title, prompt, state, model, effort, session_id) values ($1, $2, 'Earlier task', 'Earlier prompt', 'completed', 'claude-opus-5-5', 'xhigh', $3)", [earlierTask, AGENT, randomUUID()]);
      const otherTask = randomUUID();
      const otherAgent = randomUUID();
      await db.query("insert into domain_requests (id, agent_id, task_id, domains, reason) values ($1, $2, $3, '{*.shop.example}', 'Other task')", [otherTask, AGENT, earlierTask]);
      await db.query("insert into domain_requests (id, agent_id, task_id, domains, reason) values ($1, $2, $3, '{*.shop.example}', 'Other agent')", [otherAgent, AGENT2, taskId]);

      const refused = cli.callTool({ name: "request_domains", arguments: { domains: ["www.shop.example"], reason: "Open the shop" } });
      const first = await waitFor(async () => (await openFor("agent_id = $1 and task_id = $2", [AGENT, taskId]))[0], "this task's own site request");
      expect([otherTask, otherAgent]).not.toContain(first.id);
      expect((await api("POST", `/api/domain-requests/${first.id}/decide`, { decision: "refuse", attended: false })).status).toBe(200);
      expect(textOf(await refused)).toContain("The owner refused shop.example. Find another way or tell the owner what you cannot do.");

      // A refused request is not reused: asking again opens a new card.
      const again = cli.callTool({ name: "request_domains", arguments: { domains: ["shop.example"], reason: "Try the shop again" } });
      const second = await waitFor(async () => (await openFor("agent_id = $1 and task_id = $2", [AGENT, taskId]))[0], "a new site request after the refusal");
      expect(second.id).not.toBe(first.id);
      expect((await api("POST", `/api/domain-requests/${second.id}/decide`, { decision: "allow_task", attended: true })).status).toBe(200);
      expect(textOf(await again)).toContain("Allowed only during an attended session: shop.example, each with all its subdomains. Reload the page.");

      // An allowed request is not reused either.
      const third = cli.callTool({ name: "request_domains", arguments: { domains: ["shop.example"], reason: "And once more" } });
      const newest = await waitFor(async () => (await openFor("agent_id = $1 and task_id = $2", [AGENT, taskId]))[0], "a new site request after the allow");
      expect([first.id, second.id]).not.toContain(newest.id);
      expect((await api("POST", `/api/domain-requests/${newest.id}/decide`, { decision: "allow_task", attended: false })).status).toBe(200);
      expect(textOf(await third)).toContain("Allowed: shop.example");

      const cards = (await db.query<{ event: { requestId: string } }>("select event from task_events where task_id = $1 and event->>'kind' = 'domain_request' order by seq", [taskId])).rows;
      expect(cards.map(row => row.event.requestId)).toEqual([first.id, second.id, newest.id]);
      expect((await openFor("id = any($1::uuid[])", [[otherTask, otherAgent]])).map(row => row.id).sort()).toEqual([otherTask, otherAgent].sort());
    } finally {
      await cli.close();
      await db.query("delete from domain_requests where reason in ('Other task', 'Other agent')");
      await db.query("delete from tasks where id = $1", [earlierTask]);
      await api("POST", `/api/tasks/${taskId}/cancel`, {});
    }
  }, 60_000);

  it("uploads an owner image, binds it to the task and delivers its bytes to the run", async () => {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64");
    const uploaded = await api("POST", `/api/agents/${AGENT}/attachments?name=screen.png`, bytes, { headers: { "content-type": "image/png" } });
    expect(uploaded.status).toBe(200);
    const id = uploaded.body.id as string;
    const before = new Set(runs.keys());
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "", attachmentIds: [id] });
    expect(created.status).toBe(200);
    const taskId = created.body.id as string;
    const run = await waitFor(() => [...runs.values()].find(run => !before.has(run.runId)), "image run");
    expect(run.request.images).toEqual([{ mediaType: "image/png", data: bytes.toString("base64") }]);
    const path = `attachments/${id.slice(0, 8)}-screen.png`;
    expect(workspaceImages.get(path)).toEqual(bytes);
    expect(String(run.request.prompt)).toContain(path);
    expect((await db.query("select pending_attachment_ids from tasks where id = $1", [taskId])).rows[0].pending_attachment_ids).toEqual([]);
    expect((await db.query("select attachment_ids from runs where id = $1", [run.runId])).rows[0].attachment_ids).toEqual([id]);
    const events = (await db.query("select event from task_events where task_id = $1 and event->>'kind' = 'owner_message'", [taskId])).rows;
    expect(events[0].event).toMatchObject({ text: "", attachments: [{ id, name: "screen.png", width: 1, height: 1 }] });
    expect(JSON.stringify(events)).not.toContain(bytes.toString("base64"));
    const rejected = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Reuse should fail", attachmentIds: [id] });
    expect(rejected.status).toBe(400);
    emit(run, { type: "result", subtype: "success", is_error: false, result: "I can see the image.", session_id: "image-session", usage: { input_tokens: 1, output_tokens: 1 } });
    run.state = "exited"; run.exitCode = 0;
    await waitFor(async () => (await api("GET", `/api/tasks/${taskId}`)).body.task.state === "completed" ? true : undefined, "image task completed");
  }, 60_000);

  it("claims agent 2 atomically, renames it, removes its data and reuses the clean slot", async () => {
    expect((await api("GET", "/api/agents")).body).toMatchObject({ agents: [{ id: AGENT }], capacity: { used: 1, total: 2 } });
    expect((await api("POST", `/api/agents/${AGENT2}/view-ticket`, {})).body.error.code).toBe("unknown_agent");
    const claims = await Promise.all([api("POST", "/api/agents", { name: "Invoices" }), api("POST", "/api/agents", { name: "Receipts" })]);
    expect(claims.map(result => result.status).sort()).toEqual([201, 409]);
    expect(claims.find(result => result.status === 201)?.body).toMatchObject({ id: AGENT2, index: 2, cliSignedIn: "no" });
    const renamed = await api("PUT", `/api/agents/${AGENT2}/settings`, { name: "  Accounts  ", model: "claude-opus-5-5", effort: "xhigh" });
    expect(renamed.body.name).toBe("Accounts");
    const saved = await api("POST", `/api/agents/${AGENT2}/logins`, { name: "Vendor", sites: ["vendor.example.com"], username: "owner", password: "private-password" });
    expect(saved.status).toBe(200);
    const ticket = await api("POST", `/api/agents/${AGENT2}/view-ticket`, {});
    expect(ticket.status).toBe(200);
    const taskId = randomUUID();
    const runId = randomUUID();
    const token = secret();
    await db.query("insert into tasks (id, agent_id, title, prompt, state, model, effort, session_id) values ($1, $2, 'Old chat', 'Old prompt', 'completed', 'claude-opus-5-5', 'xhigh', $3)", [taskId, AGENT2, randomUUID()]);
    await db.query("insert into runs (id, task_id, agent_id, attempt, state, prompt, resume, mcp_token_hash, diagnostic) values ($1, $2, $3, 1, 'running', 'test', false, $4, true)", [runId, taskId, AGENT2, sha256Hex(token)]);
    const wrongListener = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    expect(wrongListener.status).toBe(401);
    const slotClient = new Client({ name: "slot-test", version: "1" });
    await slotClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.2:${mcpPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as never);
    expect((await slotClient.listTools()).tools.length).toBeGreaterThan(0);
    await slotClient.close();
    await db.query("update runs set state = 'exited', finalized = true, token_revoked = true where id = $1", [runId]);
    const events = new TaskEvents(db);
    await events.append(db, taskId, { kind: "assistant_text", text: "Private old message" });
    await db.query(`insert into message_reactions (task_id, seq, "by", emoji) values ($1, 1, 'owner', '👍')`, [taskId]);
    await db.query("insert into owner_requests (id, task_id, run_id, kind, text) values ($1, $2, $3, 'question', 'Private old question')", [randomUUID(), taskId, runId]);
    const auditBefore = await db.query("select count(*)::int as n from audit_events where agent_id = $1", [AGENT2]);
    expect((await api("DELETE", `/api/agents/${AGENT2}`)).status).toBe(200);
    expect(supervisorCalls).toContain(`POST /v1/agents/${AGENT2}/wipe`);
    expect((await api("GET", `/api/agents/${AGENT2}`)).status).toBe(404);
    for (const table of ["tasks", "runs", "logins", "view_tickets"]) expect((await db.query(`select count(*)::int as n from ${table} where agent_id = $1`, [AGENT2])).rows[0].n).toBe(0);
    for (const table of ["task_events", "message_reactions", "owner_requests"]) expect((await db.query(`select count(*)::int as n from ${table} where task_id = $1`, [taskId])).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int as n from audit_events where agent_id = $1", [AGENT2])).rows[0].n).toBeGreaterThan(auditBefore.rows[0].n);
    const recreated = await api("POST", "/api/agents", { name: "Fresh agent" });
    expect(recreated.body).toMatchObject({ id: AGENT2, name: "Fresh agent", cliSignedIn: "no" });
    const currentAudit = await api("GET", `/api/agents/${AGENT2}/audit`);
    expect(currentAudit.body.events.map((event: { type: string }) => event.type)).toEqual(["agent.added"]);
    expect((await api("GET", `/api/agents/${AGENT2}/audit/verify`)).body).toMatchObject({ ok: true });
    expect((await api("DELETE", `/api/agents/${AGENT2}`)).status).toBe(200);
  });

  // A phone's session, as the phone sign-in routes create it.
  async function phoneSession(opts: { expires?: string; absolute?: string; name?: string } = {}): Promise<{ token: string; id: string }> {
    const token = secret();
    await db.query(
      `insert into sessions (hash, expires_at, absolute_expires_at, device_name, client)
       values ($1, now() + $2::interval, now() + $3::interval, $4, 'phone')`,
      [sha256Hex(token), opts.expires ?? "30 days", opts.absolute ?? "180 days", opts.name ?? "Test iPhone"],
    );
    return { token, id: sha256Hex(token).slice(0, 16) };
  }
  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  it("accepts a phone's bearer token without an Origin and only that way", async () => {
    const phone = await phoneSession();
    const asPhone = { cookie: false, origin: null, headers: bearer(phone.token) } as const;
    expect((await api("GET", "/api/agents", undefined, asPhone)).status).toBe(200);
    expect((await api("POST", `/api/agents/${AGENT}/view-ticket`, {}, asPhone)).status).toBe(200);
    // An Origin, when sent, must still be the app's own.
    expect((await api("POST", `/api/agents/${AGENT}/view-ticket`, {}, { ...asPhone, origin: "https://evil.example" })).status).toBe(403);
    expect((await api("POST", `/api/agents/${AGENT}/view-ticket`, {}, { ...asPhone, origin: `http://localhost:${appPort}` })).status).toBe(200);
    // A cookie request without an Origin is still refused.
    expect((await api("POST", `/api/agents/${AGENT}/view-ticket`, {}, { origin: null })).status).toBe(403);
    // A phone token in the cookie is not a session, and a browser's cookie token is not a bearer token.
    expect((await api("GET", "/api/agents", undefined, { cookie: false, extraCookie: `qb_session=${phone.token}` })).status).toBe(401);
    expect((await api("GET", "/api/agents", undefined, { cookie: false, headers: bearer(sessionToken) })).status).toBe(401);
    // With an Authorization header the cookies are ignored: a broken header is signed out even with a valid cookie.
    for (const authorization of ["Basic b3duZXI6cGFzcw==", "Bearer", `Bearer ${phone.token} extra`, `bearer ${phone.token}`]) {
      expect((await api("GET", "/api/agents", undefined, { headers: { authorization } })).status).toBe(401);
    }
    // The kill capability cookie is ignored next to an Authorization header, so it cannot ride along a bad token.
    const killed = await api("POST", `/api/agents/${AGENT}/kill`, {}, { cookie: false, origin: null, headers: bearer("not-a-session-token-at-all"), extraCookie: `qb_kill=${killCapability(killSecret, 1)}` });
    expect(killed.status).toBe(401);
    expect(supervisorCalls).not.toContain(`POST /v1/agents/${AGENT}/computer/kill`);
    // A phone session never counts as a fresh passkey check: it cannot start the browser re-check, and a fresh_until on
    // its row is ignored.
    expect((await api("POST", `/api/agents/${AGENT}/kill/release`, {}, asPhone)).body.error.code).toBe("fresh_auth_required");
    const recheck = await api("POST", "/api/desktop-link/start", { kind: "fresh", deviceName: "Test Mac" }, asPhone);
    expect(recheck.status).toBe(403);
    expect(recheck.body.error.code).toBe("phone_not_fresh");
    await db.query("update sessions set fresh_until = now() + interval '10 minutes' where hash = $1", [sha256Hex(phone.token)]);
    expect((await api("POST", `/api/agents/${AGENT}/kill/release`, {}, asPhone)).body.error.code).toBe("fresh_auth_required");
    expect((await api("GET", "/api/me", undefined, asPhone)).body.freshUntil).toBeNull();
    const devices = await api("GET", "/api/sessions");
    expect(devices.body.sessions).toContainEqual(expect.objectContaining({ id: phone.id, deviceName: "Test iPhone", client: "phone", current: false }));
  });

  it("keeps a phone signed in while it is used, up to its absolute end, and never a browser", async () => {
    const used = await phoneSession({ expires: "2 days" });
    expect((await api("GET", "/api/me", undefined, { cookie: false, headers: bearer(used.token) })).status).toBe(200);
    const slid = await db.query<{ days: number }>("select (extract(epoch from expires_at - now()) / 86400)::float8 as days from sessions where hash = $1", [sha256Hex(used.token)]);
    expect(slid.rows[0]!.days).toBeGreaterThan(29.9);
    // Used again within a day of the last renewal: still 30 days from this use.
    const recent = await phoneSession({ expires: "29 days 12 hours" });
    await api("GET", "/api/me", undefined, { cookie: false, headers: bearer(recent.token) });
    const recentDays = await db.query<{ days: number }>("select (extract(epoch from expires_at - now()) / 86400)::float8 as days from sessions where hash = $1", [sha256Hex(recent.token)]);
    expect(recentDays.rows[0]!.days).toBeGreaterThan(29.99);
    const capped = await phoneSession({ expires: "2 days", absolute: "3 days" });
    await api("GET", "/api/me", undefined, { cookie: false, headers: bearer(capped.token) });
    const cappedDays = await db.query<{ days: number }>("select (extract(epoch from expires_at - now()) / 86400)::float8 as days from sessions where hash = $1", [sha256Hex(capped.token)]);
    expect(cappedDays.rows[0]!.days).toBeLessThan(3.01);
    const browserBefore = await db.query<{ expires_at: Date }>("select expires_at from sessions where hash = $1", [sha256Hex(sessionToken)]);
    await api("GET", "/api/me");
    const browserAfter = await db.query<{ expires_at: Date }>("select expires_at from sessions where hash = $1", [sha256Hex(sessionToken)]);
    expect(browserAfter.rows[0]!.expires_at).toEqual(browserBefore.rows[0]!.expires_at);
    const expired = await phoneSession({ expires: "-1 second" });
    for (const [method, path] of [["GET", "/api/agents"], ["GET", "/api/inbox"], ["POST", `/api/agents/${AGENT}/view-ticket`]] as const) {
      expect((await api(method, path, method === "POST" ? {} : undefined, { cookie: false, origin: null, headers: bearer(expired.token) })).status).toBe(401);
    }
  });

  it("revoking a phone closes its task stream and its viewer socket, and its token stops working", async () => {
    const phone = await phoneSession();
    const asPhone = { cookie: false, origin: null, headers: bearer(phone.token) } as const;
    const task = await db.query<{ id: string }>("select id from tasks where agent_id = $1 order by created_at limit 1", [AGENT]);
    const taskId = task.rows[0]!.id;
    let streamEnded = false;
    let streamStatus = 0;
    const stream = http.get({
      host: "127.0.0.1", port: appPort, path: `/api/tasks/${taskId}/events?after=0`,
      headers: { host: `localhost:${appPort}`, ...bearer(phone.token) },
    }, response => {
      streamStatus = response.statusCode ?? 0;
      response.resume();
      response.on("end", () => { streamEnded = true; });
      response.on("close", () => { streamEnded = true; });
    });
    stream.on("error", () => { streamEnded = true; });
    await waitFor(() => streamStatus === 200 || undefined, "phone task stream");
    await db.query("update agents set selkies_owner_token = 'owner-token' where id = $1", [AGENT]);
    const viewer = await openViewer(phone.token);
    let viewerClosed = false;
    viewer.on("close", () => { viewerClosed = true; });
    expect((await api("DELETE", `/api/sessions/${phone.id}`)).status).toBe(200);
    await waitFor(() => (streamEnded && viewerClosed) || undefined, "stream and viewer closed");
    for (const [method, path] of [["GET", "/api/agents"], ["GET", `/api/tasks/${taskId}`], ["POST", `/api/agents/${AGENT}/view-ticket`]] as const) {
      expect((await api(method, path, method === "POST" ? {} : undefined, asPhone)).status).toBe(401);
    }
  });

  it("closes an open viewer socket when its 12-hour viewer cookie runs out", async () => {
    const phone = await phoneSession();
    await db.query("update agents set selkies_owner_token = 'owner-token' where id = $1", [AGENT]);
    const viewer = await openViewer(phone.token);
    let closed = false;
    viewer.on("close", () => { closed = true; });
    await db.query("update view_sessions set expires_at = now() - interval '1 second' where session_hash = $1", [sha256Hex(phone.token)]);
    await waitFor(() => closed || undefined, "viewer closed by the sweep", 20_000);
    // The owner session itself is still signed in: only the viewer's capability ended.
    expect((await api("GET", "/api/me", undefined, { cookie: false, headers: bearer(phone.token) })).status).toBe(200);
  }, 30_000);

  const nativeApp = { cookie: false, origin: null } as const;
  async function phoneSessionRow(token: string) {
    return (await db.query<{ client: string; device_name: string; fresh_until: Date | null; absolute_expires_at: Date | null }>(
      "select client, device_name, fresh_until, absolute_expires_at from sessions where hash = $1", [sha256Hex(token)])).rows[0];
  }

  it("signs a phone in with a passkey, bound to a phone challenge and the app's origin, with the token only in the body", async () => {
    expect((await api("GET", "/api/desktop/info", undefined, nativeApp)).body.phoneApi).toBe(1);
    const options = await api("POST", "/api/phone/passkey/options", {}, nativeApp);
    expect(options.status).toBe(200);
    expect(options.headers["cache-control"]).toBe("no-store");
    expect(options.setCookie).toEqual([]);
    const verify = (challengeId: string, response: unknown) => api("POST", "/api/phone/passkey/verify", { challengeId, response, deviceName: "Owner's iPhone" }, nativeApp);
    // Made on another origin: refused.
    expect((await verify(options.body.challengeId, passkey.assert(options.body.options, "https://evil.example"))).status).toBe(403);
    // The refused attempt used the challenge up; a new one signs in.
    const again = await api("POST", "/api/phone/passkey/options", {}, nativeApp);
    const signedIn = await verify(again.body.challengeId, passkey.assert(again.body.options));
    expect(signedIn.status).toBe(200);
    expect(signedIn.setCookie).toEqual([]);
    expect(signedIn.headers["cache-control"]).toBe("no-store");
    const token = signedIn.body.token as string;
    expect(await phoneSessionRow(token)).toMatchObject({ client: "phone", device_name: "Owner's iPhone", fresh_until: null });
    expect((await phoneSessionRow(token))!.absolute_expires_at).not.toBeNull();
    expect((await api("GET", "/api/me", undefined, { ...nativeApp, headers: bearer(token) })).status).toBe(200);
    // Used once.
    expect((await verify(again.body.challengeId, passkey.assert(again.body.options))).status).toBe(403);
    // A browser sign-in challenge cannot finish a phone sign-in.
    const browser = await api("POST", "/api/auth/options", {}, { cookie: false });
    const browserChallenge = browser.setCookie.find((c) => c.startsWith("qb_challenge="))!.split(";")[0]!.slice("qb_challenge=".length);
    expect((await verify(browserChallenge, passkey.assert(browser.body))).status).toBe(403);
  });

  it("signs a phone in through a link approved in the browser, and each app collects only its own links", async () => {
    const started = await api("POST", "/api/phone/link/start", { deviceName: "Owner's iPhone" }, nativeApp);
    expect(started.status).toBe(200);
    expect(started.body.verifyUrl).toBe(`http://localhost:${appPort}/link#${started.body.userCode}`);
    const poll = (path: string, pollToken: string) => api("POST", path, { pollToken }, nativeApp);
    expect((await poll("/api/phone/link/poll", started.body.pollToken)).status).toBe(202);
    expect((await api("GET", `/api/desktop-link/pending?code=${started.body.userCode}`)).body).toMatchObject({ kind: "signin", client: "phone", deviceName: "Owner's iPhone" });
    await approveWithPasskey(started.body.userCode);
    // The desktop poll neither collects nor spends a phone link.
    const asDesktop = await api("POST", "/api/desktop-link/poll", { pollToken: started.body.pollToken }, { cookie: false });
    expect(asDesktop.status).toBe(410);
    expect(asDesktop.setCookie).toEqual([]);
    const collected = await poll("/api/phone/link/poll", started.body.pollToken);
    expect(collected.status).toBe(200);
    expect(collected.body).toEqual({ state: "approved", token: expect.any(String) });
    expect(collected.setCookie).toEqual([]);
    expect(await phoneSessionRow(collected.body.token)).toMatchObject({ client: "phone", device_name: "Owner's iPhone", fresh_until: null });
    expect((await api("GET", "/api/agents", undefined, { ...nativeApp, headers: bearer(collected.body.token) })).status).toBe(200);
    expect((await poll("/api/phone/link/poll", started.body.pollToken)).status).toBe(410);
    // The phone poll neither collects nor spends a desktop link.
    const desktop = await api("POST", "/api/desktop-link/start", { kind: "signin", deviceName: "Some Mac" }, { cookie: false });
    await approveWithPasskey(desktop.body.userCode);
    expect((await poll("/api/phone/link/poll", desktop.body.pollToken)).body).toEqual({ state: "expired" });
    expect((await api("POST", "/api/desktop-link/poll", { pollToken: desktop.body.pollToken }, { cookie: false })).body).toEqual({ state: "approved" });
    // A refused link stays refused: it cannot be approved afterwards, refused twice, or collected.
    const refused = await api("POST", "/api/phone/link/start", { deviceName: "Someone's iPhone" }, nativeApp);
    expect((await api("POST", "/api/desktop-link/refuse", { userCode: refused.body.userCode })).status).toBe(200);
    expect((await api("POST", "/api/desktop-link/approve/options", { userCode: refused.body.userCode })).status).toBe(404);
    expect((await api("POST", "/api/desktop-link/refuse", { userCode: refused.body.userCode })).status).toBe(404);
    expect((await poll("/api/phone/link/poll", refused.body.pollToken)).body).toEqual({ state: "refused" });
  });

  it("signs a phone in with an operator code as many times as it allows, and revoking signs those phones out", async () => {
    const make = async (uses: number, expires = "1 day") => {
      const code = newPairingCode();
      await db.query("insert into pairing_codes (hash, uses_left, expires_at) values ($1, $2, now() + $3::interval)", [pairingCodeHash(code), uses, expires]);
      return code;
    };
    const redeem = (code: string, deviceName = "Reviewer iPhone") => api("POST", "/api/phone/code", { code, deviceName }, nativeApp);
    const twice = await make(2);
    const first = await redeem(twice.toLowerCase().replaceAll("-", " "));
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect((await redeem(twice)).status).toBe(200);
    const spent = await redeem(twice);
    expect(spent.status).toBe(403);
    expect(spent.body.error.code).toBe("code_invalid");
    expect((await redeem(await make(1, "-1 second"))).status).toBe(403);
    expect((await redeem(newPairingCode())).status).toBe(403);
    // Concurrent uses of a code with one use left make one session.
    const once = await make(1);
    const raced = await Promise.all(Array.from({ length: 6 }, (_, i) => redeem(once, `Racer ${i}`)));
    expect(raced.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await db.query("select count(*)::int as n from sessions where pairing_code_hash = $1", [pairingCodeHash(once)])).rows[0].n).toBe(1);
    expect(await phoneSessionRow(first.body.token)).toMatchObject({ client: "phone", device_name: "Reviewer iPhone", fresh_until: null });
    // The code never reaches the audit log.
    const audit = await db.query<{ data: unknown }>("select data from audit_events where type = 'owner.signed_in' order by seq desc limit 3");
    expect(JSON.stringify(audit.rows)).not.toContain(twice.replaceAll("-", ""));
    expect(audit.rows[0]!.data).toMatchObject({ through: "code" });
    // Revoking the codes (the operator's revoke-pairing-codes) signs out every phone that used one.
    const operator = new Auth(db, controlConfig, new AuditLog(db, controlConfig.secrets.auditHmacKey), () => [AGENT]);
    const revoked = await operator.revokePairingCodes();
    expect(revoked.codes).toBeGreaterThan(0);
    expect(revoked.sessions).toBe(3);
    expect((await api("GET", "/api/me", undefined, { ...nativeApp, headers: bearer(first.body.token) })).status).toBe(401);
    expect((await redeem(await make(1))).status).toBe(200);
  });

  it("never opens the terminal for a phone token", async () => {
    const phone = await phoneSession();
    const refused = (headers: Record<string, string>) => new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${appPort}/api/agents/${AGENT}/terminal`, { headers: { host: `localhost:${appPort}`, origin: `http://localhost:${appPort}`, ...headers } });
      socket.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.on("open", () => { socket.close(); resolve(101); });
      socket.on("error", () => resolve(-1));
    });
    expect(await refused(bearer(phone.token))).toBe(403);
    expect(await refused({ cookie: `qb_session=${phone.token}` })).toBe(401);
  });

  // A viewer socket opened the way the phone opens it: a view ticket from its bearer token, redeemed on the viewer
  // origin for the viewer cookie, then the WebSocket with that cookie and the viewer Origin.
  async function openViewer(token: string): Promise<WebSocket> {
    const ticket = await api("POST", `/api/agents/${AGENT}/view-ticket`, {}, { cookie: false, origin: null, headers: bearer(token) });
    expect(ticket.status).toBe(200);
    const url = new URL(ticket.body.url as string);
    const redeemed = await api("GET", `${url.pathname}${url.search}`, undefined, { cookie: false, origin: null, host: `view.localhost:${appPort}` });
    expect(redeemed.status).toBe(303);
    const viewCookie = redeemed.setCookie.find((c) => c.startsWith("qb_view="))!.split(";")[0]!;
    const socket = new WebSocket(`ws://127.0.0.1:${appPort}/agents/${AGENT}/api/websockets`, {
      headers: { host: `view.localhost:${appPort}`, origin: `http://view.localhost:${appPort}`, cookie: viewCookie },
    });
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    return socket;
  }

  // --- The owner's permission to send to the AI provider ------------------------------------------------------------

  const DISCLOSURE = AI_PROVIDERS.anthropic.disclosureVersion;
  async function taskWhen(taskId: string, state: string): Promise<any> {
    return waitFor(async () => {
      const detail = await api("GET", `/api/tasks/${taskId}`);
      return detail.body.task.state === state ? detail.body.task : undefined;
    }, `task ${state}`);
  }
  // A task as an app queued it before the server knew of any withdrawal: straight into the queue, past the HTTP check.
  async function queuedTask(agentId: string, prompt: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `insert into tasks (id, agent_id, title, prompt, state, model, effort, session_id, pending_prompt)
       values ($1, $2, $3, $3, 'queued', 'claude-opus-5-5', 'xhigh', $4, $3)`, [id, agentId, prompt, randomUUID()]);
    control.tasks.kick();
    return id;
  }

  it("refuses to dispatch without the owner's consent on a server that requires it", async () => {
    controlConfig.aiConsentRequired = true;
    try {
      const agent = (await api("GET", `/api/agents/${AGENT}`)).body;
      expect(agent.aiConsent).toMatchObject({ provider: "anthropic", disclosureVersion: DISCLOSURE, state: "not_asked", required: true, allowed: false });
      const refused = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Pay the electricity bill." });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toEqual({ code: "ai_consent_required", message: "Allow sending to Anthropic for this agent first." });

      // A task already in the queue never reaches the model either: dispatch ends it without starting a run.
      const before = runs.size;
      const leasesBefore = leases.length;
      const queued = await queuedTask(AGENT, "Queued before the server required consent.");
      const ended = await taskWhen(queued, "cancelled");
      expect(ended.error).toBe("Not sent: allow sending to Anthropic for this agent, then send it again.");
      expect(runs.size).toBe(before);
      // The agent never got the browser for it.
      expect(leases.slice(leasesBefore).some((lease) => lease.holder === "agent")).toBe(false);

      // Allowing names the disclosure and the agent occupant the app showed it for.
      const stale = await api("PUT", `/api/agents/${AGENT}/ai-consent`, { allow: true, provider: "anthropic", disclosureVersion: "2000-01-01", generation: agent.generation });
      expect(stale.body.error.code).toBe("disclosure_changed");
      const replaced = await api("PUT", `/api/agents/${AGENT}/ai-consent`, { allow: true, provider: "anthropic", disclosureVersion: DISCLOSURE, generation: agent.generation + 1 });
      expect(replaced.body.error.code).toBe("agent_replaced");
      expect((await api("GET", `/api/agents/${AGENT}/ai-consent`)).body).toMatchObject({ state: "not_asked", allowed: false });

      const allowed = await api("PUT", `/api/agents/${AGENT}/ai-consent`, { allow: true, provider: "anthropic", disclosureVersion: DISCLOSURE, generation: agent.generation });
      expect(allowed.body).toMatchObject({ state: "granted", allowed: true, changedBy: { client: "browser", deviceName: "Browser" } });
      const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Pay the electricity bill." });
      expect(created.status).toBe(200);
      const run = await waitFor(() => [...runs.values()][before], "run after consent");
      await finishRun(run, "Paid.");
      await taskWhen(created.body.id, "completed");

      const owner = (await db.query("select webauthn_user_id from owner_account")).rows[0].webauthn_user_id;
      const records = (await db.query("select owner_id, agent_generation, granted, disclosure_version, client from ai_consents where agent_id = $1 order by id", [AGENT])).rows;
      expect(records).toEqual([{ owner_id: owner, agent_generation: agent.generation, granted: true, disclosure_version: DISCLOSURE, client: "browser" }]);
      const audit = (await api("GET", `/api/agents/${AGENT}/audit`)).body.events.find((e: { type: string }) => e.type === "ai_consent.granted");
      expect(audit.data).toEqual({ provider: "anthropic", disclosureVersion: DISCLOSURE, client: "browser", deviceName: "Browser" });
    } finally {
      controlConfig.aiConsentRequired = false;
    }
  }, 30_000);

  it("stops queued and running tasks when the phone withdraws consent, before anything more reaches the model", async () => {
    const phone = await phoneSession({ name: "Owner's iPhone" });
    const asPhone = { cookie: false, origin: null, headers: bearer(phone.token) } as const;
    const before = runs.size;
    const running = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Compare three phone plans." });
    const run = await waitFor(() => [...runs.values()][before], "running task's run");
    // One run per agent: this one waits in the queue behind it.
    const queued = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Then cancel the old plan." });
    expect(queued.status).toBe(200);

    const withdrawn = await api("PUT", `/api/agents/${AGENT}/ai-consent`, { allow: false, provider: "anthropic" }, asPhone);
    expect(withdrawn.body).toMatchObject({ state: "withdrawn", allowed: false, changedBy: { client: "phone", deviceName: "Owner's iPhone" } });
    // By the time the reply returns, the running CLI is cancelled, its tool token is dead and the queued task ended.
    expect(run.state).toBe("cancelled");
    const cli = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: "POST", headers: { authorization: `Bearer ${String(run.request.mcpToken)}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(cli.status).toBe(401);
    const stopped = "Stopped: sending to Anthropic is off for this agent.";
    expect((await api("GET", `/api/tasks/${queued.body.id}`)).body.task).toMatchObject({ state: "cancelled", error: stopped });
    expect((await taskWhen(running.body.id, "cancelled")).error).toBe(stopped);
    await new Promise((r) => setTimeout(r, 1500));
    expect(runs.size).toBe(before + 1);

    // The phone's withdrawal holds for every app: the browser cannot send either, and nothing slips into the queue.
    const refused = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Try anyway." });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toEqual({ code: "ai_consent_required", message: "Sending to Anthropic is off for this agent. Turn it on to send." });
    expect((await api("POST", `/api/tasks/${running.body.id}/message`, { text: "Go on." }, asPhone)).body.error.code).toBe("ai_consent_required");
    const late = await queuedTask(AGENT, "Queued by an app that missed the withdrawal.");
    expect((await taskWhen(late, "cancelled")).error).toBe(stopped);
    expect(runs.size).toBe(before + 1);
    const types = (await api("GET", `/api/agents/${AGENT}/audit`)).body.events.map((e: { type: string }) => e.type);
    expect(types).toContain("ai_consent.withdrawn");

    // Allowing again from the browser lets new work run.
    const generation = (await api("GET", `/api/agents/${AGENT}`)).body.generation;
    expect((await api("PUT", `/api/agents/${AGENT}/ai-consent`, { allow: true, provider: "anthropic", disclosureVersion: DISCLOSURE, generation })).body).toMatchObject({ state: "granted", allowed: true });
    const again = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Compare three phone plans." });
    await finishRun(await waitFor(() => [...runs.values()][before + 1], "run after allowing again"), "Compared.");
    await taskWhen(again.body.id, "completed");
  }, 30_000);

  it("never lets one consent cover another agent, an earlier agent in the same slot or another owner", async () => {
    controlConfig.aiConsentRequired = true;
    try {
      expect((await api("GET", `/api/agents/${AGENT}/ai-consent`)).body).toMatchObject({ state: "granted", allowed: true });
      const second = await api("POST", "/api/agents", { name: "Second" });
      expect(second.body).toMatchObject({ id: AGENT2, aiConsent: { state: "not_asked", allowed: false } });
      expect((await api("POST", `/api/agents/${AGENT2}/tasks`, { prompt: "x" })).body.error.code).toBe("ai_consent_required");

      // Records that name another owner, or the agent that had this slot before, do not count.
      await db.query(
        `insert into ai_consents (agent_id, agent_generation, owner_id, provider, granted, disclosure_version, client, device_name)
         values ($1, $2, 'another-owner', 'anthropic', true, $3, 'phone', 'Their iPhone'),
                ($1, $2 - 1, (select webauthn_user_id from owner_account), 'anthropic', true, $3, 'phone', 'Owner''s iPhone')`,
        [AGENT2, second.body.generation, DISCLOSURE]);
      expect((await api("GET", `/api/agents/${AGENT2}/ai-consent`)).body).toMatchObject({ state: "not_asked", allowed: false });
      const queued = await queuedTask(AGENT2, "Should never run.");
      expect((await taskWhen(queued, "cancelled")).error).toBe("Not sent: allow sending to Anthropic for this agent, then send it again.");
      expect(supervisorCalls).not.toContain(`POST /v1/agents/${AGENT2}/runs`);

      // Removing the agent removes its records.
      expect((await api("DELETE", `/api/agents/${AGENT2}`)).status).toBe(200);
      expect((await db.query("select count(*)::int as n from ai_consents where agent_id = $1", [AGENT2])).rows[0].n).toBe(0);
    } finally {
      controlConfig.aiConsentRequired = false;
    }
  }, 30_000);

  it("lets only a signed-in owner from the app's own origin read or change the AI consent record", async () => {
    const path = `/api/agents/${AGENT}/ai-consent`;
    const generation = (await api("GET", `/api/agents/${AGENT}`)).body.generation;
    const allow = { allow: true, provider: "anthropic", disclosureVersion: DISCLOSURE, generation };
    const rowsBefore = (await db.query("select count(*)::int as n from ai_consents")).rows[0].n;
    expect((await api("GET", path, undefined, { cookie: false })).body.error.code).toBe("signed_out");
    expect((await api("PUT", path, { allow: false, provider: "anthropic" }, { cookie: false })).body.error.code).toBe("signed_out");
    const crossOrigin = await api("PUT", path, { allow: false, provider: "anthropic" }, { origin: "https://evil.example" });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.error.code).toBe("bad_origin");
    expect((await api("PUT", path, { allow: false, provider: "anthropic" }, { origin: null })).status).toBe(403);
    // A revoked phone's token is signed out.
    const phone = await phoneSession({ name: "Lost iPhone" });
    await db.query("update sessions set revoked_at = now() where hash = $1", [sha256Hex(phone.token)]);
    const revoked = await api("PUT", path, { allow: false, provider: "anthropic" }, { cookie: false, origin: null, headers: bearer(phone.token) });
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe("signed_out");
    expect((await api("PUT", path, { ...allow, extra: 1 })).status).toBe(400);
    expect((await db.query("select count(*)::int as n from ai_consents")).rows[0].n).toBe(rowsBefore);
    expect((await api("GET", path)).body).toMatchObject({ state: "granted", allowed: true });
  });

  it("signs every agent in to Claude once, drops a sign-in Claude refuses, and signs out", async () => {
    const code = { code: "abcdefgh_1234#state_abcdefgh" };
    const own = (await db.query("select cli_signed_in from agents where id = $1", [AGENT])).rows[0].cli_signed_in;
    const started = await api("POST", `/api/agents/${AGENT}/claude-sign-in`, {});
    expect(started.status).toBe(200);
    const finished = await api("POST", `/api/claude-sign-in/${started.body.signInId}/code`, code);
    expect(finished.body).toEqual({ signedIn: true, signedInAt: claudeToken!.at });
    expect((await api("GET", "/api/claude-sign-in")).body).toEqual(finished.body);
    for (const agent of (await api("GET", "/api/agents")).body.agents) expect(agent).toMatchObject({ cliSignedIn: "yes", cliAccount: null, cliPlan: null });
    expect((await db.query("select id from claude_sign_in")).rows).toEqual([{ id: started.body.signInId }]);

    // A run started after the sign-in runs with it. Claude refusing it removes it for every agent, the agent's own
    // sign-in untouched.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = runs.size;
    const created = await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "Check the plan." });
    expect(created.status).toBe(200);
    const run = await waitFor(() => [...runs.values()][before], "run with the shared sign-in");
    emit(run, { type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", session_id: "c", usage: { input_tokens: 1, output_tokens: 1 } });
    run.state = "exited";
    run.exitCode = 1;
    expect((await taskWhen(created.body.id, "failed")).error).toBe("Claude Code is signed out. Sign in to Claude, then try again.");
    expect((await api("GET", "/api/claude-sign-in")).body).toEqual({ signedIn: false, signedInAt: null });
    expect(supervisorCalls).toContain(`DELETE /v1/claude-token/${started.body.signInId}`);
    expect(claudeToken).toBeNull();
    expect((await db.query("select cli_signed_in from agents where id = $1", [AGENT])).rows[0].cli_signed_in).toBe(own);

    // A sign-in that finishes after a later one leaves the later one recorded, as the supervisor keeps its token.
    const later = randomUUID();
    await db.query("insert into claude_sign_in (id, signed_in_at) values ($1, now() + interval '1 hour')", [later]);
    const again = await api("POST", `/api/agents/${AGENT}/claude-sign-in`, {});
    await api("POST", `/api/claude-sign-in/${again.body.signInId}/code`, code);
    expect((await db.query("select id from claude_sign_in")).rows).toEqual([{ id: later }]);
    expect((await api("DELETE", "/api/claude-sign-in", undefined, { origin: "https://evil.example" })).status).toBe(403);
    const out = await api("DELETE", "/api/claude-sign-in");
    expect(out.body).toEqual({ signedIn: false, signedInAt: null });
    expect(supervisorCalls).toContain("DELETE /v1/claude-token");
    expect((await db.query("select 1 from claude_sign_in")).rows).toEqual([]);
    const types = (await api("GET", `/api/agents/${AGENT}/audit`)).body.events.map((e: { type: string; actor: string }) => `${e.actor} ${e.type}`);
    expect(types).toEqual(expect.arrayContaining(["owner claude.signed_in", "system claude.signed_out", "owner claude.signed_out"]));
  }, 30_000);

  it("keeps the audit log append-only for the application role", async () => {
    await expect(db.query("update audit_events set data = '{}' where seq = 1")).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from audit_events")).rejects.toThrow(/permission denied/);
    await expect(db.query("truncate audit_events")).rejects.toThrow(/permission denied|must be owner/);
  });

  it("kill switch freezes egress, kills the computer and refuses new tasks", async () => {
    const before = egressFrozen;
    // Only the signed kill capability, no session: the path that works while the database is down.
    const killed = await api("POST", `/api/agents/${AGENT}/kill`, {}, { cookie: false, extraCookie: `qb_kill=${killCapability(killSecret, 1)}` });
    expect(killed.status).toBe(200);
    expect(egressFrozen).toBe(before + 1);
    expect(supervisorCalls).toContain(`POST /v1/agents/${AGENT}/computer/kill`);
    expect((await api("POST", `/api/agents/${AGENT}/tasks`, { prompt: "again" })).status).toBe(409);
    const frozenPolicy = policies.at(-1) as { agents: Record<string, { frozen: boolean }> };
    expect(frozenPolicy.agents[AGENT]?.frozen).toBe(true);
    const all = await api("POST", "/api/agents/kill-all", {}, { cookie: false, extraCookie: `qb_kill=${killCapability(killSecret, 1)}` });
    expect(all.body).toMatchObject({ confirmed: true, agents: [{ agentId: AGENT, egressFrozen: true, sandboxesStopped: true, error: null }] });
    expect((await api("POST", "/api/agents/kill-all", {}, { cookie: false })).status).toBe(401);
  });

  // Last in the file: it uses up this address's sign-in allowance for the minute.
  it("rate-limits the routes that work without a session", async () => {
    let limited: { status: number; body: any } | undefined;
    for (let attempt = 0; attempt < 40 && !limited; attempt += 1) {
      const response = await api("POST", "/api/auth/options", {}, { cookie: false });
      if (response.status === 429) limited = response;
    }
    expect(limited?.body).toMatchObject({ error: { code: "rate_limited" } });
    expect(String(limited?.body.error.message)).toMatch(/^Too many requests\. Try again in /);
    // Signed-in routes keep their own, much larger allowance.
    expect((await api("GET", "/api/inbox")).status).toBe(200);
  });
});
