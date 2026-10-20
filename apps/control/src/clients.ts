import http from "node:http";
import type { Readable } from "node:stream";
import {
  ClaudeSignInStart,
  ClaudeSignInStatus,
  BrowserCommandResult,
  type BrowserCommandRequest,
  type SecretFillRequest,
  type OwnerFillRequest,
  OwnerFocusResult,
  ScreenSize,
  type ScreenRequest,
  ComputerStatus,
  type ControlLease,
  DownloadInfo,
  type EgressPolicySnapshot,
  EgressDecisionsResponse,
  ExecResult,
  type ExecRequest,
  FilesResult,
  type FilesRequest,
  type FilesExportRequest,
  RunOutputLine,
  RunStatus,
  SiteDataClearResult,
  type StartRunRequest,
} from "@quokkabot/shared";
import { z } from "zod";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string,
  ) {
    super(message);
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
}

function rawRequest(options: http.RequestOptions, body: string | Buffer | null, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on("error", reject);
    if (body !== null) req.end(body);
    else req.end();
  });
}

async function readAll(stream: Readable, limit = 32 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error("upstream response too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function jsonCall<T>(
  base: { socketPath?: string; host?: string; port?: number },
  token: string,
  method: string,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  timeoutMs: number,
): Promise<T> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const res = await rawRequest(
    {
      ...base,
      method,
      path,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== null ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      },
    },
    payload,
    timeoutMs,
  );
  const text = await readAll(res.stream);
  if (res.status < 200 || res.status >= 300) {
    throw new UpstreamError(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  }
  let value: unknown = null;
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      // Selkies answers some calls with plain text ("OK"); a schema that accepts anything takes the text.
      value = text;
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UpstreamError(`${method} ${path}: unexpected response: ${parsed.error.message}`, res.status, text);
  return parsed.data;
}

// --- Supervisor (unix socket) -------------------------------------------------------------------------------------

export class SupervisorClient {
  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  private call<T>(method: string, path: string, body: unknown, schema: z.ZodType<T>, timeoutMs = 60_000): Promise<T> {
    return jsonCall({ socketPath: this.socketPath }, this.token, method, path, body, schema, timeoutMs);
  }

  startSignIn(agentId: string): Promise<ClaudeSignInStart> {
    return this.call("POST", `/v1/agents/${agentId}/claude-sign-in`, {}, ClaudeSignInStart, 60_000);
  }
  submitSignIn(signInId: string, code: string): Promise<ClaudeSignInStatus> {
    return this.call("POST", `/v1/claude-sign-in/${signInId}/code`, { code }, ClaudeSignInStatus, 120_000);
  }
  cancelSignIn(signInId: string): Promise<unknown> {
    return this.call("DELETE", `/v1/claude-sign-in/${signInId}`, undefined, z.unknown(), 30_000);
  }
  signInStatus(agentId: string): Promise<ClaudeSignInStatus> {
    return this.call("GET", `/v1/agents/${agentId}/claude-sign-in/status`, undefined, ClaudeSignInStatus, 30_000);
  }

  computer(agentId: string): Promise<ComputerStatus> {
    return this.call("GET", `/v1/agents/${agentId}/computer`, undefined, ComputerStatus, 15_000);
  }
  start(agentId: string): Promise<unknown> {
    return this.call("POST", `/v1/agents/${agentId}/computer/start`, {}, z.unknown(), 180_000);
  }
  stop(agentId: string): Promise<unknown> {
    return this.call("POST", `/v1/agents/${agentId}/computer/stop`, {}, z.unknown(), 120_000);
  }
  wipe(agentId: string): Promise<unknown> {
    return this.call("POST", `/v1/agents/${agentId}/wipe`, {}, z.unknown(), 180_000);
  }
  kill(agentId: string): Promise<ComputerStatus> {
    return this.call("POST", `/v1/agents/${agentId}/computer/kill`, {}, ComputerStatus, 60_000);
  }
  unlatch(agentId: string): Promise<unknown> {
    return this.call("POST", `/v1/agents/${agentId}/computer/unlatch`, {}, z.unknown(), 15_000);
  }
  startRun(agentId: string, request: StartRunRequest): Promise<RunStatus> {
    return this.call("POST", `/v1/agents/${agentId}/runs`, request, RunStatus, 60_000);
  }
  run(runId: string): Promise<RunStatus> {
    return this.call("GET", `/v1/runs/${runId}`, undefined, RunStatus, 15_000);
  }
  cancelRun(runId: string): Promise<unknown> {
    return this.call("POST", `/v1/runs/${runId}/cancel`, {}, z.unknown(), 30_000);
  }
  cleanupRun(agentId: string, runId: string, sessionId: string): Promise<unknown> {
    return this.call("POST", `/v1/agents/${agentId}/runs/${runId}/cleanup`, { sessionId }, z.unknown(), 30_000);
  }
  resetTools(agentId: string): Promise<unknown> {
    return this.call("POST", `/v1/agents/${agentId}/tools/reset`, {}, z.unknown(), 30_000);
  }
  exec(agentId: string, request: ExecRequest): Promise<ExecResult> {
    return this.call("POST", `/v1/agents/${agentId}/exec`, request, ExecResult, (request.timeoutS + 30) * 1000);
  }
  files(agentId: string, request: FilesRequest): Promise<FilesResult> {
    return this.call("POST", `/v1/agents/${agentId}/files`, request, FilesResult, 120_000);
  }

  async writeWorkspaceFile(agentId: string, path: string, data: Buffer): Promise<void> {
    const res = await rawRequest({ socketPath: this.socketPath, method: "POST",
      path: `/v1/agents/${agentId}/workspace-file?path=${encodeURIComponent(path)}`,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream", "content-length": data.length },
    }, data, 60_000);
    const text = await readAll(res.stream);
    if (res.status !== 200) throw new UpstreamError(`Workspace write ${res.status}: ${text.slice(0, 200)}`, res.status, text);
  }

  async runOutput(runId: string, from: number, waitS: number): Promise<RunOutputLine[]> {
    const res = await rawRequest(
      {
        socketPath: this.socketPath,
        method: "GET",
        path: `/v1/runs/${runId}/output?from=${from}&wait=${waitS}`,
        headers: { authorization: `Bearer ${this.token}` },
      },
      null,
      (waitS + 15) * 1000,
    );
    const text = await readAll(res.stream);
    if (res.status !== 200) throw new UpstreamError(`run output ${res.status}: ${text.slice(0, 200)}`, res.status, text);
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => RunOutputLine.parse(JSON.parse(line)));
  }

  // Raw bytes of a file in the tools sandbox; the caller streams it to the owner.
  async exportFile(agentId: string, request: FilesExportRequest): Promise<RawResponse> {
    const payload = JSON.stringify(request);
    const res = await rawRequest(
      {
        socketPath: this.socketPath,
        method: "POST",
        path: `/v1/agents/${agentId}/files/export`,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      payload,
      300_000,
    );
    if (res.status !== 200) {
      const text = await readAll(res.stream);
      throw new UpstreamError(`export ${res.status}: ${text.slice(0, 200)}`, res.status, text);
    }
    return res;
  }

  terminalRequestOptions(agentId: string): { socketPath: string; path: string; headers: Record<string, string> } {
    return {
      socketPath: this.socketPath,
      path: `/v1/agents/${agentId}/terminal`,
      headers: { authorization: `Bearer ${this.token}` },
    };
  }
}

// --- Egress control API -------------------------------------------------------------------------------------------

export class EgressClient {
  private readonly host: string;
  private readonly port: number;

  constructor(
    url: string,
    private readonly token: string,
  ) {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 80);
  }

  putPolicy(snapshot: EgressPolicySnapshot): Promise<unknown> {
    return jsonCall({ host: this.host, port: this.port }, this.token, "PUT", "/v1/policy", snapshot, z.unknown(), 10_000);
  }
  freeze(agentId: string): Promise<unknown> {
    return jsonCall({ host: this.host, port: this.port }, this.token, "POST", `/v1/agents/${agentId}/freeze`, {}, z.unknown(), 10_000);
  }
  decisions(after: number, waitS: number): Promise<EgressDecisionsResponse> {
    return jsonCall(
      { host: this.host, port: this.port },
      this.token,
      "GET",
      `/v1/decisions?after=${after}&wait=${waitS}`,
      undefined,
      EgressDecisionsResponse,
      (waitS + 10) * 1000,
    );
  }
}

// --- Browser service ----------------------------------------------------------------------------------------------

export class BrowserServiceClient {
  private readonly host: string;
  private readonly port: number;

  constructor(
    url: string,
    private readonly token: string,
  ) {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 80);
  }

  private base(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }

  command(request: BrowserCommandRequest, timeoutMs = 90_000): Promise<BrowserCommandResult> {
    return jsonCall(this.base(), this.token, "POST", "/v1/commands", request, BrowserCommandResult, timeoutMs);
  }
  // The value goes only to the browser service, which types it through DevTools after checking site and field.
  secretFill(request: SecretFillRequest): Promise<BrowserCommandResult> {
    return jsonCall(this.base(), this.token, "POST", "/v1/secret-fill", request, BrowserCommandResult, 60_000);
  }
  async ownerFocus(generation: number): Promise<OwnerFocusResult> {
    try {
      return await jsonCall(this.base(), this.token, "GET", `/v1/owner-focus?generation=${generation}`, undefined, OwnerFocusResult, 60_000);
    } catch (error) {
      let blocked = false;
      if (error instanceof UpstreamError && error.status === 409) {
        try { blocked = JSON.parse(error.body).status === "blocked"; } catch { /* An invalid reply is a failure. */ }
      }
      throw new UpstreamError("owner focus failed", blocked ? 409 : null, "");
    }
  }
  async ownerFill(request: OwnerFillRequest): Promise<BrowserCommandResult> {
    try {
      const result = await jsonCall(this.base(), this.token, "POST", "/v1/owner-fill", request, BrowserCommandResult, 60_000);
      // Only the browser's bound handle knows the insertion's origin. The phone cannot choose the audit site.
      if (result.status === "ok" && (!result.url || new URL(result.url).origin !== result.url)) throw new Error("missing owner fill origin");
      return result;
    } catch {
      // Neither transport errors nor an invalid reply may echo the native field's value.
      throw new Error("owner fill failed");
    }
  }
  commandResult(commandId: string): Promise<BrowserCommandResult> {
    return jsonCall(this.base(), this.token, "GET", `/v1/commands/${commandId}`, undefined, BrowserCommandResult, 10_000);
  }
  // Fits the screen to the owner's phone; the browser service refuses it unless that lease is the owner's.
  setScreen(request: ScreenRequest): Promise<ScreenSize> {
    return jsonCall(this.base(), this.token, "PUT", "/v1/screen", request, ScreenSize, 30_000);
  }
  setLease(lease: ControlLease): Promise<unknown> {
    return jsonCall(this.base(), this.token, "PUT", "/v1/control-lease", lease, z.unknown(), 30_000);
  }
  downloads(sinceIso: string | null): Promise<{ downloads: DownloadInfo[] }> {
    const query = sinceIso === null ? "" : `?since=${encodeURIComponent(sinceIso)}`;
    return jsonCall(this.base(), this.token, "GET", `/v1/downloads${query}`, undefined, z.object({ downloads: z.array(DownloadInfo) }), 15_000);
  }
  async downloadContent(downloadId: string): Promise<RawResponse> {
    const res = await rawRequest(
      { ...this.base(), method: "GET", path: `/v1/downloads/${downloadId}/content`, headers: { authorization: `Bearer ${this.token}` } },
      null,
      300_000,
    );
    if (res.status !== 200) {
      const text = await readAll(res.stream);
      throw new UpstreamError(`download content ${res.status}: ${text.slice(0, 200)}`, res.status, text);
    }
    return res;
  }
  ack(downloadId: string): Promise<unknown> {
    return jsonCall(this.base(), this.token, "POST", `/v1/downloads/${downloadId}/ack`, {}, z.unknown(), 15_000);
  }
  clearSiteData(patterns: string[]): Promise<SiteDataClearResult> {
    return jsonCall(this.base(), this.token, "POST", "/v1/site-data/clear", { patterns }, SiteDataClearResult, 60_000);
  }
  shutdown(): Promise<unknown> {
    return jsonCall(this.base(), this.token, "POST", "/v1/shutdown", {}, z.unknown(), 60_000);
  }
  health(): Promise<unknown> {
    return jsonCall(this.base(), this.token, "GET", "/health", undefined, z.unknown(), 5_000);
  }
}

// --- Selkies (secure mode token table) ----------------------------------------------------------------------------

export class SelkiesClient {
  private readonly host: string;
  private readonly port: number;

  constructor(
    url: string,
    private readonly masterToken: string,
  ) {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 80);
  }

  get upstream(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }

  // Selkies starts some seconds after the browser service; /api/status answers once it serves.
  async ready(): Promise<boolean> {
    try {
      await jsonCall({ host: this.host, port: this.port }, this.masterToken, "GET", "/api/status", undefined, z.unknown(), 5_000);
      return true;
    } catch {
      return false;
    }
  }

  // The whole table is replaced on every call. `agent-lock` holding mk_control makes every other client view-only,
  // enforced by Selkies on the server; moving mk_control to the owner's token is the takeover.
  setTokens(ownerToken: string, ownerHasControl: boolean): Promise<unknown> {
    const table: Record<string, { role: string; mk_control?: boolean }> = ownerHasControl
      ? { [ownerToken]: { role: "controller", mk_control: true } }
      : { [ownerToken]: { role: "controller" }, "agent-lock": { role: "controller", mk_control: true } };
    return jsonCall({ host: this.host, port: this.port }, this.masterToken, "POST", "/api/tokens", table, z.unknown(), 10_000);
  }
}
