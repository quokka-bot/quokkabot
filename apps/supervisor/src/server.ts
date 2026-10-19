import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import { chmod, lstat, unlink, readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { ClaudeSignInCode, AgentId, RunId, StartRunRequest, ExecRequest, FilesRequest, FilesExportRequest, TerminalClientFrame, MAX_IMAGE_BYTES, MAX_IMAGE_BASE64, MAX_MESSAGE_IMAGES, RelPath } from "@quokkabot/shared";
import { Supervisor, ApiError } from "./supervisor.js";
import type { Terminal } from "./supervisor.js";
import type { SupervisorConfig } from "./config.js";
import type { SupervisorOptions } from "./supervisor.js";
import { isMissing } from "./storage.js";
import { DockerError } from "./docker.js";

const Empty = z.object({}).strict();
const Cleanup = z.object({ sessionId: z.uuid() }).strict();
const TerminalFrame = z.discriminatedUnion("t", [TerminalClientFrame.options[0].strict(), TerminalClientFrame.options[1].strict()]);
const OutputQuery = z.object({
  from: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).default(0),
  wait: z.string().regex(/^(?:\d+)(?:\.\d+)?$/).transform(Number).pipe(z.number().min(0).max(25)).default(0),
}).strict();

async function waitForDrain(stream: Writable): Promise<void> {
  if (stream.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { stream.off("drain", finished); stream.off("close", finished); stream.off("error", failed); };
    const finished = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    stream.once("drain", finished);
    stream.once("close", finished);
    stream.once("error", failed);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
function errorResponse(error: unknown): { status: number; body: { error: string; message: string } } {
  if (error instanceof ApiError) return { status: error.status, body: { error: error.code, message: error.message } };
  if (error instanceof z.ZodError || error instanceof SyntaxError) return { status: 400, body: { error: "invalid_request", message: "Request does not match the supervisor schema" } };
  if (error instanceof DockerError) return { status: 502, body: { error: "docker_failure", message: error.message } };
  if (error instanceof AggregateError) return { status: 502, body: { error: "supervisor_failure", message: error.message } };
  return { status: 502, body: { error: "supervisor_failure", message: "Supervisor operation failed" } };
}
export const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
export const START_RUN_BODY_LIMIT = MAX_MESSAGE_IMAGES * MAX_IMAGE_BASE64 + 1024 * 1024;
export function jsonBodyLimit(operation: string): number { return operation === "runs" ? START_RUN_BODY_LIMIT : DEFAULT_BODY_LIMIT; }
export async function readBodyBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += (chunk as Buffer).length;
    if (bytes > limit) throw new ApiError(413, "body_too_large", "Request body exceeded the size limit");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
async function body(request: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<unknown> {
  const bytes = await readBodyBytes(request, limit);
  if (bytes.length === 0) return {};
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ApiError(415, "json_required", "A JSON content type is required");
  return JSON.parse(bytes.toString("utf8"));
}

export class SupervisorServer {
  readonly http: http.Server;
  private readonly websocket = new WebSocketServer({ noServer: true, maxPayload: 6 * 65_536 + 1024, perMessageDeflate: false });
  private tokenHash: Buffer | undefined;
  private listening = false;
  private closing = false;
  private readonly upgradeTasks = new Set<Promise<void>>();
  constructor(readonly supervisor: Supervisor) {
    this.http = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, (request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        const result = errorResponse(error);
        this.supervisor.log({ event: "request_failed", status: result.status, code: result.body.error });
        if (!response.headersSent) json(response, result.status, result.body); else response.destroy();
      });
    });
    this.http.on("upgrade", (request, socket, head) => {
      const task = this.upgrade(request, socket, head);
      this.upgradeTasks.add(task);
      void task.catch((error: unknown) => {
        const result = errorResponse(error);
        this.supervisor.log({ event: "terminal_rejected", status: result.status });
        socket.end(`HTTP/1.1 ${result.status} ${http.STATUS_CODES[result.status] ?? "Error"}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(result.body)}`);
      }).finally(() => this.upgradeTasks.delete(task));
    });
  }

  private authorize(request: IncomingMessage): void {
    const header = request.headers.authorization;
    const candidate = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const hash = createHash("sha256").update(candidate).digest();
    if (!this.tokenHash || !timingSafeEqual(hash, this.tokenHash)) throw new ApiError(401, "unauthorized", "A valid supervisor bearer token is required");
  }

  async initialize(): Promise<void> {
    await this.supervisor.initialize();
    const token = (await readFile(this.supervisor.config.tokenFile, "utf8")).replace(/\r?\n$/, "");
    if (token.length < 1 || /[\r\n\0]/.test(token)) throw new Error("Supervisor token file contains an invalid token");
    this.tokenHash = createHash("sha256").update(token).digest();
  }

  async listen(): Promise<void> {
    const path = this.supervisor.config.socketPath;
    try {
      const stat = await lstat(path);
      if (!stat.isSocket()) throw new Error("Refusing to replace a non-socket at socketPath");
      // Probe before removing a stale socket, so a second supervisor cannot steal a live endpoint.
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ socketPath: path, path: "/health", timeout: 1000 }, (response) => { response.resume(); reject(new Error("Another supervisor is already listening")); });
        request.on("timeout", () => request.destroy(new Error("Existing supervisor socket did not respond")));
        request.on("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" || error.code === "ENOENT" ? resolve() : reject(error));
      });
      await unlink(path);
    } catch (error) { if (!isMissing(error)) throw error; }
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { this.http.off("listening", ready); reject(error); };
      const ready = () => { this.http.off("error", failed); resolve(); };
      this.http.once("error", failed);
      this.http.once("listening", ready);
      this.http.listen(path);
    });
    this.listening = true;
    await chmod(path, 0o660);
    // Claim the endpoint before touching run state. A second process must not reconcile a live supervisor's runs.
    // Requests are refused until initialize installs the token hash after reconciliation.
    await this.initialize();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://supervisor");
    this.authorize(request);
    if (request.method === "GET" && url.pathname === "/health") { json(response, 200, { ok: true }); return; }
    const agentRoute = /^\/v1\/agents\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (agentRoute) {
      const agentId = AgentId.parse(agentRoute[1]);
      const agent = this.supervisor.agent(agentId);
      const path = agentRoute[2];
      const known = ["computer", "computer/start", "computer/stop", "computer/kill", "computer/unlatch", "wipe", "runs", "exec", "tools/reset", "files", "files/export", "workspace-file", "claude-sign-in", "claude-sign-in/status"];
      const operation = path && known.includes(path) ? path : /^runs\/[^/]+\/cleanup$/.test(path ?? "") ? "runs/cleanup" : "unknown";
      this.supervisor.log({ event: "request", method: request.method, agentId, operation });
      if (request.method === "GET" && path === "computer") { json(response, 200, await this.supervisor.status(agent)); return; }
      if (request.method === "GET" && path === "claude-sign-in/status") { json(response, 200, await this.supervisor.signInStatus(agent)); return; }
      if (request.method === "POST") {
        if (path === "workspace-file") {
          if (request.headers["content-type"] !== "application/octet-stream") throw new ApiError(415, "binary_required", "A binary content type is required");
          const relative = RelPath.parse(url.searchParams.get("path"));
          await this.supervisor.writeWorkspaceFile(agent, relative, await readBodyBytes(request, MAX_IMAGE_BYTES));
          json(response, 200, { ok: true }); return;
        }
        const input = await body(request, jsonBodyLimit(path ?? ""));
        switch (path) {
          case "claude-sign-in": Empty.parse(input); json(response, 200, await this.supervisor.startSignIn(agent)); return;
          case "computer/start": Empty.parse(input); json(response, 200, await this.supervisor.start(agent)); return;
          case "computer/stop": Empty.parse(input); json(response, 200, await this.supervisor.stop(agent)); return;
          case "computer/kill": Empty.parse(input); json(response, 200, await this.supervisor.kill(agent)); return;
          case "computer/unlatch": Empty.parse(input); json(response, 200, await this.supervisor.unlatch(agent)); return;
          case "wipe": Empty.parse(input); await this.supervisor.wipe(agent); json(response, 200, { ok: true }); return;
          case "runs": json(response, 202, await this.supervisor.startRun(agent, StartRunRequest.parse(input))); return;
          case "exec": json(response, 200, await this.supervisor.exec(agent, ExecRequest.parse(input))); return;
          case "tools/reset": Empty.parse(input); await this.supervisor.resetTools(agent); json(response, 200, { ok: true }); return;
          case "files": json(response, 200, await this.supervisor.files(agent, FilesRequest.parse(input))); return;
          case "files/export": {
            const file = await this.supervisor.exportFile(agent, FilesExportRequest.parse(input));
            try { response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" }); await pipeline(createReadStream(file.path), response); }
            finally { await file.dispose(); }
            return;
          }
        }
        const cleanup = /^runs\/([^/]+)\/cleanup$/.exec(path ?? "");
        if (cleanup) { await this.supervisor.cleanup(agent, RunId.parse(cleanup[1]), Cleanup.parse(input).sessionId); json(response, 200, { ok: true }); return; }
      }
    }
    const signInRoute = /^\/v1\/claude-sign-in\/([^/]+)(?:\/(code))?$/.exec(url.pathname);
    if (signInRoute) {
      const id = z.uuid().parse(signInRoute[1]);
      if (request.method === "POST" && signInRoute[2] === "code") { json(response, 200, await this.supervisor.submitSignIn(id, ClaudeSignInCode.parse(await body(request)).code)); return; }
      if (request.method === "DELETE" && !signInRoute[2]) { await this.supervisor.cancelSignIn(id); json(response, 200, { ok: true }); return; }
    }
    const runRoute = /^\/v1\/runs\/([^/]+)(?:\/(output|cancel))?$/.exec(url.pathname);
    if (runRoute) {
      const record = this.supervisor.run(RunId.parse(runRoute[1]));
      if (request.method === "GET" && !runRoute[2]) { json(response, 200, record.status); return; }
      if (request.method === "POST" && runRoute[2] === "cancel") { Empty.parse(await body(request)); json(response, 200, await this.supervisor.cancel(record)); return; }
      if (request.method === "GET" && runRoute[2] === "output") {
        const values: Record<string, string> = {};
        for (const [key, value] of url.searchParams) { if (key in values) throw new ApiError(400, "invalid_query", "Duplicate output query parameter"); values[key] = value; }
        const query = OutputQuery.parse(values);
        const abort = new AbortController();
        response.once("close", () => abort.abort());
        await this.supervisor.runs.wait(record, query.from, query.wait, abort.signal);
        if (abort.signal.aborted) return;
        response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
        const maximum = record.status.lines;
        for await (const line of this.supervisor.runs.output(record.status.runId, query.from, maximum)) {
          if (!response.write(JSON.stringify(line) + "\n")) await waitForDrain(response);
          if (response.destroyed) break;
        }
        response.end();
        return;
      }
    }
    throw new ApiError(404, "not_found", "Supervisor route does not exist");
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.closing) throw new ApiError(503, "closing", "Supervisor is stopping");
    this.authorize(request);
    const url = new URL(request.url ?? "/", "http://supervisor");
    const route = /^\/v1\/agents\/([^/]+)\/terminal$/.exec(url.pathname);
    if (request.method !== "GET" || !route) throw new ApiError(404, "not_found", "Terminal route does not exist");
    const agent = this.supervisor.agent(AgentId.parse(route[1]));
    if (request.headers.upgrade?.toLowerCase() !== "websocket" || request.headers["sec-websocket-version"] !== "13" || !/^[+/0-9A-Za-z]{22}==$/.test(String(request.headers["sec-websocket-key"]))) throw new ApiError(400, "invalid_upgrade", "A valid WebSocket upgrade is required");
    if (socket.destroyed) return;
    const terminal = await this.supervisor.openTerminal(agent);
    if (socket.destroyed || this.closing) { terminal.stream.destroy(); terminal.release(); socket.destroy(); return; }
    let accepted = false;
    try {
      this.websocket.handleUpgrade(request, socket, head, (ws) => { accepted = true; this.relayTerminal(ws, terminal); });
      if (!accepted) { terminal.stream.destroy(); terminal.release(); }
    }
    catch (error) { terminal.stream.destroy(); terminal.release(); throw error; }
  }

  private relayTerminal(ws: WebSocket, terminal: Terminal): void {
    const decoder = new StringDecoder("utf8");
    let operations = Promise.resolve();
    let queuedBytes = 0;
    let queuedFrames = 0;
    const send = (frame: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 1024 * 1024) { ws.close(1009, "Terminal consumer is too slow"); terminal.stream.destroy(); return; }
      ws.send(JSON.stringify(frame));
    };
    ws.on("message", (bytes, binary) => {
      try {
        if (binary) throw new Error("Binary terminal frame");
        const frame = TerminalFrame.parse(JSON.parse(bytes.toString()));
        const size = frame.t === "in" ? Buffer.byteLength(frame.d) : 0;
        queuedBytes += size;
        queuedFrames++;
        if (queuedBytes > 1024 * 1024 || queuedFrames > 256) throw new Error("Terminal input queue exceeded its limit");
        operations = operations.then(async () => {
          queuedBytes -= size;
          queuedFrames--;
          if (ws.readyState !== WebSocket.OPEN) return;
          if (frame.t === "resize") await this.supervisor.docker.resizeExec(terminal.execId, frame.cols, frame.rows);
          else if (!terminal.stream.write(frame.d)) await waitForDrain(terminal.stream);
        });
        void operations.catch(() => { ws.close(1011, "Terminal relay failed"); terminal.stream.destroy(); });
      } catch { ws.close(1008, "Invalid terminal frame"); terminal.stream.destroy(); }
    });
    ws.once("error", () => terminal.stream.destroy());
    ws.once("close", () => { terminal.stream.destroy(); });
    void (async () => {
      try {
        for await (const chunk of terminal.stream) { const value = decoder.write(chunk as Buffer); if (value !== "") send({ t: "out", d: value }); }
        const end = decoder.end();
        if (end !== "") send({ t: "out", d: end });
        const state = await this.supervisor.waitExec(terminal.execId);
        send({ t: "exit", code: state.ExitCode });
        ws.close(1000);
      } catch { if (ws.readyState === WebSocket.OPEN) { send({ t: "exit", code: null }); ws.close(1011, "Terminal stream ended unexpectedly"); } }
      finally { terminal.release(); }
    })();
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const ws of this.websocket.clients) ws.terminate();
    const closed = this.listening ? new Promise<void>((resolve) => this.http.close(() => resolve())) : Promise.resolve();
    this.http.closeAllConnections();
    await this.supervisor.close();
    await Promise.allSettled(this.upgradeTasks);
    await closed;
    this.websocket.close();
    this.listening = false;
  }
}

export async function createServer(config: SupervisorConfig, options: SupervisorOptions = {}): Promise<SupervisorServer> {
  const server = new SupervisorServer(new Supervisor(config, options));
  try { await server.listen(); return server; }
  catch (error) { await server.close(); throw error; }
}
