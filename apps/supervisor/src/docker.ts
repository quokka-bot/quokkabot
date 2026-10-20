import http from "node:http";
import type { Duplex } from "node:stream";

// Explicit fields instead of constructor parameter properties: this file must stay erasable TypeScript so
// scripts/real-docker-smoke.ts can run it under Node's type stripping without a build.
export class DockerError extends Error {
  readonly statusCode: number;
  readonly operation: string;
  // The Engine's JSON error `message` (for example "unknown or invalid runtime name: runsc"), when it sent one.
  readonly engineMessage: string | null;
  constructor(statusCode: number, operation: string, engineMessage: string | null = null) {
    super(`Docker ${operation} failed with HTTP ${statusCode}${engineMessage === null ? "" : `: ${engineMessage}`}`);
    this.statusCode = statusCode;
    this.operation = operation;
    this.engineMessage = engineMessage;
  }
}

// Docker error bodies are `{"message": "..."}`. Anything else yields no message rather than a guess.
function engineMessage(body: Buffer): string | null {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed === "object" && parsed !== null && "message" in parsed && typeof parsed.message === "string" && parsed.message !== "") return parsed.message.slice(0, 1024);
  } catch { /* not a Docker JSON error body */ }
  return null;
}

export interface ContainerInspect {
  Id: string;
  Config: { Image: string; Labels?: Record<string, string> };
  HostConfig: { Runtime: string };
  State: { Status: string; Running: boolean; StartedAt: string };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
}
export interface NetworkInspect {
  Name: string;
  Driver: string;
  Internal: boolean;
  EnableIPv6: boolean;
  IPAM: { Config: Array<{ Subnet: string }> };
}
export interface ExecInspect { Running: boolean; ExitCode: number | null }
export interface ExecCreate {
  Cmd: string[];
  User: string;
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  Tty: boolean;
  // [rows, columns] of a TTY exec's terminal from its first byte.
  ConsoleSize?: [number, number];
  Env?: string[];
  WorkingDir?: string;
}

export class Docker {
  private readonly agent = new http.Agent({ keepAlive: true });
  private readonly streams = new Set<Duplex>();
  private readonly socketPath: string;
  constructor(socketPath: string) { this.socketPath = socketPath; }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, agent: this.agent, method, path: `/v1.47${path}`, headers: payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) response.destroy(new Error("Docker JSON response exceeded 4 MiB"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 300) { reject(new DockerError(response.statusCode ?? 500, `${method} ${path}`, engineMessage(Buffer.concat(chunks)))); return; }
          try { resolve((chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"))) as T); }
          catch (error) { reject(new Error("Invalid Docker JSON response", { cause: error })); }
        });
      });
      request.setTimeout(30_000, () => request.destroy(new Error("Docker request timed out")));
      request.on("error", reject);
      request.end(payload);
    });
  }

  createContainer(name: string, body: unknown): Promise<{ Id: string }> { return this.request("POST", `/containers/create?name=${encodeURIComponent(name)}`, body); }
  startContainer(id: string): Promise<void> { return this.request("POST", `/containers/${encodeURIComponent(id)}/start`); }
  stopContainer(id: string): Promise<void> { return this.request("POST", `/containers/${encodeURIComponent(id)}/stop?t=20`); }
  killContainer(id: string): Promise<void> { return this.request("POST", `/containers/${encodeURIComponent(id)}/kill?signal=SIGKILL`); }
  inspectContainer(id: string): Promise<ContainerInspect> { return this.request("GET", `/containers/${encodeURIComponent(id)}/json`); }
  removeContainer(id: string): Promise<void> { return this.request("DELETE", `/containers/${encodeURIComponent(id)}?force=true`); }
  createNetwork(body: unknown): Promise<{ Id: string }> { return this.request("POST", "/networks/create", body); }
  inspectNetwork(name: string): Promise<NetworkInspect> { return this.request("GET", `/networks/${encodeURIComponent(name)}`); }
  disconnectNetwork(name: string, container: string): Promise<void> { return this.request("POST", `/networks/${encodeURIComponent(name)}/disconnect`, { Container: container, Force: true }); }
  createExec(container: string, body: ExecCreate): Promise<{ Id: string }> { return this.request("POST", `/containers/${encodeURIComponent(container)}/exec`, body); }
  inspectExec(id: string): Promise<ExecInspect> { return this.request("GET", `/exec/${encodeURIComponent(id)}/json`); }
  resizeExec(id: string, cols: number, rows: number): Promise<void> { return this.request("POST", `/exec/${encodeURIComponent(id)}/resize?w=${cols}&h=${rows}`); }
  stats(id: string): Promise<{ memory_stats: { usage?: number } }> { return this.request("GET", `/containers/${encodeURIComponent(id)}/stats?stream=false&one-shot=true`); }

  async startExec(id: string, tty: boolean): Promise<Duplex> {
    const payload = JSON.stringify({ Detach: false, Tty: tty });
    return new Promise<Duplex>((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, method: "POST", path: `/v1.47/exec/${encodeURIComponent(id)}/start`, headers: {
        Connection: "Upgrade", Upgrade: "tcp", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
      } });
      request.setTimeout(30_000, () => request.destroy(new Error("Docker exec upgrade timed out")));
      request.on("upgrade", (response, socket, head) => {
        if (response.statusCode !== 101) { socket.destroy(); reject(new DockerError(response.statusCode ?? 500, "exec upgrade")); return; }
        socket.setTimeout(0);
        // Consumers can await a durable status write before reading. Preserve socket.errored without an unhandled event.
        socket.on("error", () => undefined);
        this.streams.add(socket);
        socket.once("close", () => this.streams.delete(socket));
        // Docker may put the first output bytes in the same packet as the upgrade headers.
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      request.on("response", (response) => {
        // A refused exec start (unknown exec, container not running) answers with a JSON error instead of 101.
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 64 * 1024) chunks.push(chunk); });
        response.on("error", reject);
        response.on("end", () => reject(new DockerError(response.statusCode ?? 500, "exec upgrade (expected 101)", engineMessage(Buffer.concat(chunks)))));
      });
      request.on("error", reject);
      request.end(payload);
    });
  }

  close(): void { this.agent.destroy(); for (const stream of this.streams) stream.destroy(); }
}

export async function* dockerOutput(stream: AsyncIterable<Buffer>, tty = false): AsyncGenerator<{ stream: "stdout" | "stderr"; data: Buffer }> {
  let pending: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let channel: "stdout" | "stderr" = "stdout";
  for await (const chunk of stream) {
    if (tty) { yield { stream: "stdout", data: chunk }; continue; }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length > 0) {
      if (remaining === 0) {
        if (pending.length < 8) break;
        const type = pending[0];
        if ((type !== 1 && type !== 2) || pending[1] !== 0 || pending[2] !== 0 || pending[3] !== 0) throw new Error("Invalid Docker multiplex header");
        channel = type === 1 ? "stdout" : "stderr";
        remaining = pending.readUInt32BE(4);
        pending = pending.subarray(8);
        if (remaining === 0) continue;
      }
      const length = Math.min(remaining, pending.length);
      if (length > 0) yield { stream: channel, data: pending.subarray(0, length) };
      pending = pending.subarray(length);
      remaining -= length;
    }
  }
  if (!tty && (pending.length > 0 || remaining > 0)) throw new Error("Truncated Docker multiplex stream");
}

export function dockerMissing(error: unknown): boolean { return error instanceof DockerError && error.statusCode === 404; }
