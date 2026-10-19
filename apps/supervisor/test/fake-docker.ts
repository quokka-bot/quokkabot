import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ContainerInspect, ExecCreate, NetworkInspect } from "../src/docker.js";

export interface Call { method: string; path: string; body: unknown }
export interface ExecPlan { stdout?: Buffer | string; stderr?: string; exitCode?: number; hold?: boolean; echo?: boolean; headOutput?: string }
export interface FakeExec { id: string; container: string; body: ExecCreate; input: Buffer; running: boolean; code: number | null; socket?: Duplex; plan: ExecPlan }
export function multiplex(type: 1 | 2, value: Buffer | string): Buffer {
  const bytes = Buffer.from(value);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

export class FakeDocker {
  readonly http = http.createServer((req, res) => { void this.handle(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)); }); });
  readonly calls: Call[] = [];
  readonly containers = new Map<string, ContainerInspect>();
  readonly networks = new Map<string, NetworkInspect>();
  readonly execs = new Map<string, FakeExec>();
  private execCount = 0;
  readonly plans: ExecPlan[] = [];
  readonly sockets = new Set<Duplex>();
  onCall?: (call: Call) => void;
  fail?: (call: Call) => number | undefined;

  constructor(readonly path: string) {
    this.http.on("connection", (socket) => { socket.allowHalfOpen = true; this.sockets.add(socket); socket.on("close", () => this.sockets.delete(socket)); });
    this.http.on("upgrade", (req, socket, head) => {
      this.upgrade(req, socket, head).catch((error: unknown) => { socket.end(`HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${String(error)}`); });
    });
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.http.once("error", reject); this.http.listen(this.path, () => { this.http.off("error", reject); resolve(); }); });
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.http.listening) await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
  private record(req: IncomingMessage, body: unknown): Call {
    const call = { method: req.method!, path: req.url!, body };
    this.calls.push(call);
    this.onCall?.(call);
    return call;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw === "" ? undefined : JSON.parse(raw) as Record<string, unknown>;
    const call = this.record(req, body);
    const failed = this.fail?.(call);
    if (failed) { res.writeHead(failed); res.end(JSON.stringify({ message: "canned Docker failure" })); return; }
    const url = new URL(req.url!, "http://docker");
    const path = url.pathname.replace(/^\/v1\.47/, "");
    const reply = (status: number, value?: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
    if (path === "/networks/create") {
      const network = body as unknown as NetworkInspect;
      this.networks.set(network.Name, network);
      reply(201, { Id: network.Name }); return;
    }
    const networkRoute = /^\/networks\/([^/]+)(\/disconnect)?$/.exec(path);
    if (networkRoute) {
      const name = decodeURIComponent(networkRoute[1]!);
      if (networkRoute[2]) {
        const container = this.containers.get(body?.Container as string);
        if (container) delete container.NetworkSettings.Networks[name];
        reply(container ? 200 : 404); return;
      }
      const network = this.networks.get(name);
      reply(network ? 200 : 404, network ?? { message: "no such network" }); return;
    }
    if (path === "/containers/create") {
      const name = url.searchParams.get("name")!;
      const template = body as { Image: string; Labels: Record<string, string>; HostConfig: { Runtime: string }; NetworkingConfig?: { EndpointsConfig: Record<string, { IPAMConfig: { IPv4Address: string } }> } };
      this.containers.set(name, { Id: name, Config: { Image: template.Image, Labels: template.Labels }, HostConfig: { Runtime: template.HostConfig.Runtime }, State: { Status: "created", Running: false, StartedAt: "0001-01-01T00:00:00Z" }, NetworkSettings: { Networks: Object.fromEntries(Object.entries(template.NetworkingConfig?.EndpointsConfig ?? {}).map(([key, endpoint]) => [key, { IPAddress: endpoint.IPAMConfig.IPv4Address }])) } });
      reply(201, { Id: name }); return;
    }
    const containerRoute = /^\/containers\/([^/]+)(?:\/(json|start|stop|kill|stats|exec))?$/.exec(path);
    if (containerRoute) {
      const name = decodeURIComponent(containerRoute[1]!);
      const container = this.containers.get(name);
      if (!container) { reply(404, { message: "no such container" }); return; }
      switch (containerRoute[2]) {
        case "json": reply(200, container); return;
        case "start":
          // Engine API: 304 when the container is already running.
          if (container.State.Running) { reply(304); return; }
          container.State = { Running: true, Status: "running", StartedAt: new Date().toISOString() }; reply(204); return;
        case "stop": case "kill":
          // Engine API: stop answers 304 and kill 409 when the container is not running.
          if (!container.State.Running) { if (containerRoute[2] === "stop") reply(304); else reply(409, { message: `Container ${name} is not running` }); return; }
          container.State.Running = false; container.State.Status = "exited";
          // Measured on Docker 29 (scripts/real-docker-smoke.ts and a kill probe): every running exec of the
          // container, TTY shells included, ends with 137 and stays inspectable; never-started execs disappear.
          for (const exec of [...this.execs.values()]) {
            if (exec.container !== name) continue;
            if (exec.running) this.finish(exec, 137);
            else if (exec.code === null && exec.socket === undefined) this.execs.delete(exec.id);
          }
          reply(204); return;
        case "stats": reply(200, { memory_stats: { usage: 1024 } }); return;
        case "exec": {
          if (!container.State.Running) { reply(409, { message: `Container ${name} is not running` }); return; }
          const id = `exec-${++this.execCount}`;
          const execBody = body as unknown as ExecCreate;
          const plan = this.plans.shift() ?? {};
          this.execs.set(id, { id, container: name, body: execBody, input: Buffer.alloc(0), running: false, code: null, plan });
          reply(201, { Id: id }); return;
        }
        default: this.containers.delete(name); reply(204); return;
      }
    }
    const execRoute = /^\/exec\/([^/]+)\/(json|resize)$/.exec(path);
    if (execRoute) {
      const exec = this.execs.get(execRoute[1]!);
      if (!exec) { reply(404, { message: "unknown exec" }); return; }
      reply(200, execRoute[2] === "json" ? { Running: exec.running, ExitCode: exec.code } : undefined); return;
    }
    reply(404, { message: "unhandled fake route" });
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, initial: Buffer): Promise<void> {
    const size = Number(req.headers["content-length"]);
    if (!Number.isSafeInteger(size) || size < 1) throw new Error("Fake Docker exec start requires a Content-Length JSON body");
    // Docker's Go server reads the exec start JSON from the request body, then hijacks the connection.
    // Node 26 behaves the same way: it parses the upgrade request's Content-Length body into req and only
    // bytes after the body reach head and the socket. Node 22 instead leaves the body in head and in the
    // following socket data, with req ending empty. Collect in arrival order (req body first, then head,
    // then socket data) so both releases yield the body followed by the client's first stdin bytes.
    const fromRequest: Buffer[] = [];
    const fromSocket: Buffer[] = [];
    const buffer = (chunk: Buffer) => { fromSocket.push(chunk); };
    socket.on("data", buffer);
    for await (const chunk of req) fromRequest.push(chunk as Buffer);
    let pending = Buffer.concat([...fromRequest, initial, ...fromSocket]);
    socket.off("data", buffer);
    if (pending.length < size) await new Promise<void>((resolve) => {
      const data = (chunk: Buffer) => { pending = Buffer.concat([pending, chunk]); if (pending.length >= size) { socket.off("data", data); resolve(); } };
      socket.on("data", data);
    });
    socket.pause();
    const body = JSON.parse(pending.subarray(0, size).toString()) as { Tty: boolean };
    this.record(req, body);
    const id = /\/exec\/([^/]+)\/start$/.exec(req.url!)?.[1];
    const exec = this.execs.get(id ?? "");
    if (!exec) { socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); return; }
    exec.socket = socket;
    exec.running = true;
    const headOutput = exec.plan.headOutput === undefined ? Buffer.alloc(0) : body.Tty ? Buffer.from(exec.plan.headOutput) : multiplex(1, exec.plan.headOutput);
    // The Engine's hijack response (API >= 1.42 labels the multiplexed form).
    const contentType = body.Tty ? "application/vnd.docker.raw-stream" : "application/vnd.docker.multiplexed-stream";
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 UPGRADED\r\nContent-Type: ${contentType}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`), headOutput]));
    const input = (chunk: Buffer) => {
      exec.input = Buffer.concat([exec.input, chunk]);
      if (exec.plan.echo) socket.write(chunk);
    };
    socket.on("data", input);
    if (pending.length > size) input(pending.subarray(size));
    socket.on("end", () => {
      // The client answers Docker's FIN after an exit with its own; that is not stdin EOF of a live process.
      if (exec.code !== null) return;
      if (exec.plan.hold) {
        // Docker closes a TTY exec's attach stream when the client's stdin ends but leaves the process running:
        // nothing sends SIGHUP (moby container/stream/attach.go closes stdout and stderr, not the TTY's stdin).
        // Confirmed on Docker 29 by scripts/real-docker-smoke.ts. A non-TTY process that ignores stdin keeps running.
        if (exec.body.Tty) socket.end();
        return;
      }
      if (exec.plan.stdout !== undefined) this.output(exec, "stdout", exec.plan.stdout);
      if (exec.plan.stderr !== undefined) this.output(exec, "stderr", exec.plan.stderr);
      this.finish(exec, exec.plan.exitCode ?? 0);
    });
    socket.resume();
  }

  output(exec: FakeExec, stream: "stdout" | "stderr", value: string | Buffer): void {
    exec.socket!.write(exec.body.Tty ? Buffer.from(value) : multiplex(stream === "stdout" ? 1 : 2, value));
  }
  finish(exec: FakeExec, code = 0): void {
    // A process exits once. Docker keeps the first exit code, even when the client closes the stream afterwards.
    if (exec.code === null) { exec.running = false; exec.code = code; }
    exec.socket?.end();
  }
}
