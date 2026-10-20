import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Duplex, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { claudeTaskArgv, claudeTaskEnv, claudeUserMessage, CLI_PATHS, TOOLS_PATHS, LIMITS, RunStatus, StartRunRequest } from "@quokkabot/shared";
import { SupervisorConfig, loadConfig, requireDataMarker } from "../src/config.js";
import { containerBody, cliEnvironment, networkBody } from "../src/templates.js";
import { Docker, DockerError, dockerOutput } from "../src/docker.js";
import type { ContainerInspect, ExecCreate, ExecInspect, NetworkInspect } from "../src/docker.js";
import { Supervisor } from "../src/supervisor.js";
import type { ExecPlan } from "./fake-docker.js";
import { createServer, SupervisorServer } from "../src/server.js";
import { atomicWrite, RunStore } from "../src/storage.js";
import type { StoredRun } from "../src/storage.js";
import { FakeDocker, multiplex } from "./fake-docker.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const otherRunId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const token = "supervisor-test-token-0123456789";
const runRequest = { runId, sessionId, resume: false, model: "claude-opus-4-6", effort: "xhigh", mcpToken: "m".repeat(32), prompt: "Find the invoice\nKeep this private." };
const image = (kind: string) => `quokkabot/${kind}@sha256:${"a".repeat(64)}`;

function storedRun(state: "starting" | "running", execId: string | null): StoredRun {
  return {
    status: RunStatus.parse({ runId, agentId, state, exitCode: null, startedAt: new Date().toISOString(), endedAt: null, lines: 0, lastOutputAt: null }),
    execId, cancelRequested: false,
  };
}

function configuration(root: string): SupervisorConfig {
  return SupervisorConfig.parse({
    socketPath: join(root, "api.sock"), dockerSocket: join(root, "docker.sock"), tokenFile: join(root, "token"), dataRoot: join(root, "data"), dataMarker: ".quokkabot-volume", runtime: "runsc", viewOrigin: "https://view.quokkabot.example.com",
    images: { cli: image("cli"), tools: image("tools"), browser: image("browser") },
    agents: [{ agentId, index: 1, networks: { cli: { name: "qb-cli-1", subnet: "10.231.1.0/24", address: "10.231.1.10" }, browser: { name: "qb-browser-1", subnet: "10.232.1.0/24", address: "10.232.1.10" } }, egressProxy: { cli: "http://10.231.1.2:3128", browser: "http://10.232.1.2:3128" }, controlAddress: { cli: "10.231.1.3" }, secretsDir: join(root, "secrets") }],
    limits: { cli: { memoryMb: 1536, cpus: 1, pids: 512 }, tools: { memoryMb: 1536, cpus: 1, pids: 512 }, browser: { memoryMb: 3072, cpus: 2, pids: 2048, shmMb: 1024 } },
  });
}
async function prepare(config: SupervisorConfig): Promise<void> {
  await mkdir(config.dataRoot);
  await writeFile(join(config.dataRoot, config.dataMarker), "encrypted-volume");
  await writeFile(config.tokenFile, token + "\n");
  await mkdir(config.agents[0]!.secretsDir);
  await writeFile(join(config.agents[0]!.secretsDir, "selkies_master_token"), "selkies-secret\n");
  await writeFile(join(config.agents[0]!.secretsDir, "browser_service_token"), "browser-secret\n");
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) { if (await predicate()) return; await delay(10); }
  throw new Error("Test condition did not become true");
}
interface Response { status: number; bytes: Buffer; text: string; json: unknown; headers: http.IncomingHttpHeaders }
function request(config: SupervisorConfig, method: string, path: string, input?: unknown, bearer = token): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = input === undefined ? undefined : JSON.stringify(input);
    const req = http.request({ socketPath: config.socketPath, method, path, headers: { Authorization: `Bearer ${bearer}`, ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString();
        resolve({ status: res.statusCode!, headers: res.headers, bytes, text, json: res.headers["content-type"] === "application/json" ? JSON.parse(text) as unknown : undefined });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

// Some managed sandboxes forbid bind(2), including unix sockets. Keep the integration suite written and runnable elsewhere.
async function socketsAvailable(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "qb-probe-"));
  const engine = new FakeDocker(join(root, "probe.sock"));
  try { await engine.listen(); return true; }
  catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { process.stderr.write("Supervisor integration tests skipped: sandbox forbids unix socket listening\n"); return false; } throw error; }
  finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
}
const canListen = await socketsAvailable();

describe("fixed templates and local persistence", () => {
  it("builds all three exact sandbox create bodies", () => {
    const config = configuration("/var/lib/test");
    const agent = config.agents[0]!;
    const data = `${config.dataRoot}/agents/1`;
    const common = (memory: number, cpus: number, pids: number, readonly: boolean) => ({ Runtime: "runsc", RestartPolicy: { Name: "no" }, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Memory: memory * 1024 * 1024, NanoCpus: cpus * 1e9, PidsLimit: pids, ReadonlyRootfs: readonly, Tmpfs: { "/tmp": "rw,nosuid,nodev,size=512m" } });
    const env = Object.entries({ ...claudeTaskEnv(agent.egressProxy.cli), NO_PROXY: agent.controlAddress.cli }).map(([key, value]) => `${key}=${value}`);
    expect(containerBody(config, agent, "cli")).toEqual({ Image: image("cli"), Hostname: "qb-cli-1", User: "1000:1000", Labels: { "quokkabot.agent": agentId, "quokkabot.sandbox": "cli" }, Cmd: ["sleep", "infinity"], Env: env, HostConfig: { ...common(1536, 1, 512, true), NetworkMode: "qb-cli-1", Dns: [], Binds: [`${data}/cli-state:/home/claude:rw`, `${data}/run:/run/quokkabot:rw`] }, NetworkingConfig: { EndpointsConfig: { "qb-cli-1": { IPAMConfig: { IPv4Address: "10.231.1.10" } } } } });
    expect(containerBody(config, agent, "tools")).toEqual({ Image: image("tools"), Hostname: "qb-tools-1", User: "1000:1000", Labels: { "quokkabot.agent": agentId, "quokkabot.sandbox": "tools" }, Cmd: ["sleep", "infinity"], HostConfig: { ...common(1536, 1, 512, true), NetworkMode: "none", Binds: [`${data}/workspace:/workspace:rw`, `${data}/downloads:/downloads:ro`] } });
    expect(containerBody(config, agent, "browser", { selkies: "s", browser: "b" })).toEqual({ Image: image("browser"), Hostname: "qb-browser-1", Labels: { "quokkabot.agent": agentId, "quokkabot.sandbox": "browser" }, Env: ["PUID=1000", "PGID=1000", "TZ=Etc/UTC", "QUOKKABOT_PROXY=http://10.232.1.2:3128", "SELKIES_MASTER_TOKEN=s", "QUOKKABOT_BROWSER_SERVICE_TOKEN=b", "SELKIES_ALLOWED_ORIGINS=https://view.quokkabot.example.com"], HostConfig: { ...common(3072, 2, 2048, false), NetworkMode: "qb-browser-1", CapAdd: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"], ShmSize: 1024 * 1024 * 1024, Binds: [`${data}/browser-profile:/config:rw`, `${data}/staging:/staging:rw`] }, NetworkingConfig: { EndpointsConfig: { "qb-browser-1": { IPAMConfig: { IPv4Address: "10.232.1.10" } } } } });
    expect(networkBody(agent, "cli")).toEqual({ Name: "qb-cli-1", Driver: "bridge", Internal: true, EnableIPv6: false, IPAM: { Driver: "default", Config: [{ Subnet: "10.231.1.0/24" }] } });
    expect(() => containerBody(config, agent, "browser")).toThrow("secrets");
  });

  it("rejects unsafe and duplicate config and loads the JSON config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "qb-config-"));
    try {
      const config = configuration(root);
      expect(() => SupervisorConfig.parse({ ...config, extra: true })).toThrow();
      expect(() => SupervisorConfig.parse({ ...config, images: { ...config.images, cli: "latest" } })).toThrow();
      expect(() => SupervisorConfig.parse({ ...config, agents: [config.agents[0], config.agents[0]] })).toThrow();
      const path = join(root, "config.json");
      await writeFile(path, JSON.stringify(config));
      expect(await loadConfig(path)).toEqual(config);
      await mkdir(config.dataRoot);
      await expect(requireDataMarker(config)).rejects.toThrow("marker is missing");
      await writeFile(join(config.dataRoot, config.dataMarker), "yes");
      await expect(requireDataMarker(config)).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("decodes fragmented multiplexed headers, UTF-8 bytes and raw TTY output", async () => {
    const bytes = Buffer.concat([multiplex(1, "héllo"), multiplex(2, "bad"), multiplex(1, "")]);
    const chunks = Array.from(bytes, (value) => Buffer.from([value]));
    const output: Array<{ stream: string; data: Buffer }> = [];
    for await (const chunk of dockerOutput(Readable.from(chunks))) output.push(chunk);
    expect(Buffer.concat(output.filter((item) => item.stream === "stdout").map((item) => item.data)).toString()).toBe("héllo");
    expect(Buffer.concat(output.filter((item) => item.stream === "stderr").map((item) => item.data)).toString()).toBe("bad");
    const tty = [];
    for await (const chunk of dockerOutput(Readable.from([Buffer.from("raw")]), true)) tty.push(chunk.data.toString());
    expect(tty).toEqual(["raw"]);
    await expect(async () => { for await (const _ of dockerOutput(Readable.from([bytes.subarray(0, 9)]))) { /* consume */ } }).rejects.toThrow("Truncated");
    await expect(async () => { for await (const _ of dockerOutput(Readable.from([Buffer.alloc(8, 9)]))) { /* consume */ } }).rejects.toThrow("Invalid");
  });

  it("atomically writes 0600 files and recovers output fsynced before the status update", async () => {
    const root = await mkdtemp(join(tmpdir(), "qb-store-"));
    try {
      const store = new RunStore(root);
      const parsed = StartRunRequest.parse(runRequest);
      const record = { status: { runId: parsed.runId, agentId: SupervisorConfig.parse(configuration(root)).agents[0]!.agentId, state: "running" as const, exitCode: null, startedAt: new Date().toISOString(), endedAt: null, lines: 0, lastOutputAt: null }, execId: "one", cancelRequested: false };
      await store.reserve(record);
      await store.append(record, [{ stream: "stdout", line: "one" }]);
      await atomicWrite(join(root, `${runId}.json`), JSON.stringify({ ...record, status: { ...record.status, lines: 0 } }));
      const next = new RunStore(root);
      await next.load();
      expect(next.records.get(runId)?.status.lines).toBe(1);
      expect((await stat(join(root, `${runId}.json`))).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("finishes interrupted output deletion on restart and makes removal idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "qb-remove-"));
    try {
      const store = new RunStore(root);
      const record = storedRun("running", "original");
      await store.reserve(record);
      await store.append(record, [{ stream: "stdout", line: "private tool result" }]);
      await unlink(join(root, `${runId}.json`));
      const restarted = new RunStore(root);
      await restarted.load();
      expect(restarted.records.has(runId)).toBe(false);
      expect(existsSync(join(root, `${runId}.ndjson`))).toBe(false);
      await restarted.remove(runId);
      await restarted.remove(runId);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

class ScriptedExec extends Duplex {
  input = "";
  readonly state: ExecInspect = { Running: true, ExitCode: null };
  constructor(readonly plan: ExecPlan, readonly body: ExecCreate) {
    super();
    if (plan.headOutput) this.output("stdout", plan.headOutput);
  }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { this.input += chunk.toString(); callback(); }
  override _final(callback: (error?: Error | null) => void): void {
    if (!this.plan.hold) {
      if (this.plan.stdout !== undefined) this.output("stdout", this.plan.stdout);
      if (this.plan.stderr !== undefined) this.output("stderr", this.plan.stderr);
      this.finish(this.plan.exitCode ?? 0);
    }
    callback();
  }
  output(stream: "stdout" | "stderr", value: string | Buffer): void { this.push(this.body.Tty ? Buffer.from(value) : multiplex(stream === "stdout" ? 1 : 2, value)); }
  finish(code: number): void { this.state.Running = false; this.state.ExitCode = code; this.push(null); }
}

class MemoryResponse extends Writable {
  statusCode = 200;
  headersSent = false;
  headers: Record<string, string> = {};
  readonly chunks: Buffer[] = [];
  writeHead(status: number, headers: Record<string, string>): this { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { this.chunks.push(Buffer.from(chunk)); callback(); }
}

async function memoryRequest(server: SupervisorServer, method: string, url: string, input?: unknown, bearer = token): Promise<MemoryResponse> {
  const payload = input === undefined ? "" : JSON.stringify(input);
  const incoming = Object.assign(Readable.from(payload === "" ? [] : [Buffer.from(payload)]), { method, url, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" } });
  const response = new MemoryResponse();
  const finished = new Promise<void>((resolve, reject) => { response.once("finish", resolve); response.once("error", reject); });
  server.http.emit("request", incoming, response);
  await finished;
  return response;
}

describe("supervisor logic with in-memory Docker streams", () => {
  let root: string;
  let config: SupervisorConfig;
  let service: Supervisor;
  let containers: Map<string, ContainerInspect>;
  let networks: Map<string, NetworkInspect>;
  let plans: ExecPlan[];
  let executions: Map<string, ScriptedExec>;
  let operations: string[];
  let own: string[];
  let requireLatch: boolean;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qb-memory-"));
    config = configuration(root);
    await prepare(config);
    own = [];
    service = new Supervisor(config, { own: async (path) => { own.push(path); }, log: () => undefined });
    containers = new Map(); networks = new Map(); plans = []; executions = new Map(); operations = []; requireLatch = false;
    const record = (op: string) => { if (requireLatch) expect(existsSync(join(config.dataRoot, "agents/1/killed.json"))).toBe(true); operations.push(op); };
    vi.spyOn(service.docker, "inspectContainer").mockImplementation(async (name) => { record(`inspect:${name}`); const result = containers.get(name); if (!result) throw new DockerError(404, "inspect"); return structuredClone(result); });
    vi.spyOn(service.docker, "createContainer").mockImplementation(async (name, body) => {
      record(`create:${name}`);
      const template = body as { Image: string; Labels: Record<string, string>; HostConfig: { Runtime: string }; NetworkingConfig?: { EndpointsConfig: Record<string, { IPAMConfig: { IPv4Address: string } }> } };
      containers.set(name, { Id: name, Config: { Image: template.Image, Labels: template.Labels }, HostConfig: { Runtime: template.HostConfig.Runtime }, State: { Running: false, Status: "created", StartedAt: "0001-01-01T00:00:00Z" }, NetworkSettings: { Networks: Object.fromEntries(Object.entries(template.NetworkingConfig?.EndpointsConfig ?? {}).map(([key, endpoint]) => [key, { IPAddress: endpoint.IPAMConfig.IPv4Address }])) } });
      return { Id: name };
    });
    vi.spyOn(service.docker, "startContainer").mockImplementation(async (name) => { record(`start:${name}`); containers.get(name)!.State = { Running: true, Status: "running", StartedAt: new Date().toISOString() }; });
    vi.spyOn(service.docker, "stopContainer").mockImplementation(async (name) => { record(`stop:${name}`); containers.get(name)!.State.Running = false; containers.get(name)!.State.Status = "exited"; });
    vi.spyOn(service.docker, "killContainer").mockImplementation(async (name) => { record(`kill:${name}`); const found = containers.get(name); if (!found) throw new DockerError(404, "kill"); found.State.Running = false; found.State.Status = "exited"; });
    vi.spyOn(service.docker, "removeContainer").mockImplementation(async (name) => { record(`remove:${name}`); containers.delete(name); });
    vi.spyOn(service.docker, "inspectNetwork").mockImplementation(async (name) => { record(`inspect-network:${name}`); const found = networks.get(name); if (!found) throw new DockerError(404, "network"); return found; });
    vi.spyOn(service.docker, "createNetwork").mockImplementation(async (body) => { const network = body as NetworkInspect; record(`network:${network.Name}`); networks.set(network.Name, network); return { Id: network.Name }; });
    vi.spyOn(service.docker, "disconnectNetwork").mockImplementation(async (name, container) => { record(`disconnect:${name}`); delete containers.get(container)!.NetworkSettings.Networks[name]; });
    vi.spyOn(service.docker, "stats").mockResolvedValue({ memory_stats: { usage: 99 } });
    vi.spyOn(service.docker, "createExec").mockImplementation(async (_name, body) => { const id = `e${executions.size + 1}`; executions.set(id, new ScriptedExec(plans.shift() ?? {}, body)); return { Id: id }; });
    vi.spyOn(service.docker, "startExec").mockImplementation(async (id) => executions.get(id)!);
    vi.spyOn(service.docker, "inspectExec").mockImplementation(async (id) => { const exec = executions.get(id); if (!exec) throw new DockerError(404, "exec"); return exec.state; });
    vi.spyOn(service.docker, "resizeExec").mockResolvedValue();
    vi.spyOn(service.docker, "close").mockImplementation(() => { for (const exec of executions.values()) exec.destroy(); });
    await service.initialize();
  });
  afterEach(async () => { await service.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  const agent = () => service.agent(agentId);

  it("starts and stops in order and replaces changed images", async () => {
    const status = await service.start(agent());
    expect(status.sandboxes.map((sandbox) => sandbox.memoryBytes)).toEqual([99, 99, 99]);
    expect(operations.filter((operation) => operation.startsWith("start:"))).toEqual(["start:qb-browser-1", "start:qb-tools-1", "start:qb-cli-1"]);
    containers.get("qb-cli-1")!.Config.Image = image("previous");
    await service.start(agent());
    expect(operations).toContain("remove:qb-cli-1");
    await service.stop(agent());
    expect(operations.filter((operation) => operation.startsWith("stop:"))).toEqual(["stop:qb-cli-1", "stop:qb-tools-1", "stop:qb-browser-1"]);
  });

  it("latches before Docker, joins concurrent kills and recreates disconnected sandboxes after release", async () => {
    await service.start(agent());
    operations.length = 0; requireLatch = true;
    const [first, second] = await Promise.all([service.kill(agent()), service.kill(agent())]);
    expect(first.killed).toBe(true); expect(second.killed).toBe(true);
    const disconnect = operations.flatMap((operation, index) => operation.startsWith("disconnect:") ? [index] : []);
    const kills = operations.flatMap((operation, index) => operation.startsWith("kill:") ? [index] : []);
    expect(kills).toHaveLength(3);
    expect(Math.max(...disconnect)).toBeLessThan(Math.min(...kills));
    await expect(service.start(agent())).rejects.toMatchObject({ code: "killed", status: 409 });
    await service.kill(agent());
    requireLatch = false;
    await service.unlatch(agent());
    await service.start(agent());
    expect(operations).toContain("remove:qb-cli-1");
    expect(containers.get("qb-cli-1")!.NetworkSettings.Networks["qb-cli-1"]?.IPAddress).toBe("10.231.1.10");
  });

  it("records run output durably, wakes a long poll and excludes another run and terminal", async () => {
    plans.push({ hold: true });
    const started = await service.startRun(agent(), StartRunRequest.parse(runRequest));
    expect(started.state).toBe("running");
    const exec = executions.get("e1")!;
    expect(exec.body.Cmd).toEqual(claudeTaskArgv(StartRunRequest.parse(runRequest)));
    expect(exec.body.Env).toEqual(cliEnvironment(agent()));
    expect(exec.input).toBe(claudeUserMessage(runRequest.prompt));
    const mcpPath = join(config.dataRoot, "agents/1/run/mcp.json");
    expect((await stat(mcpPath)).mode & 0o777).toBe(0o600);
    expect(own.some((path) => path.startsWith(mcpPath))).toBe(true);
    expect(await readFile(mcpPath, "utf8")).toContain(`http://${agent().controlAddress.cli}:8090/mcp`);
    await expect(service.startRun(agent(), StartRunRequest.parse({ ...runRequest, runId: otherRunId }))).rejects.toMatchObject({ code: "busy" });
    await expect(service.openTerminal(agent())).rejects.toMatchObject({ code: "busy" });
    const record = service.run(runId);
    const wake = service.runs.wait(record, 0, 2, new AbortController().signal);
    exec.output("stdout", "first\n");
    await wake;
    expect(record.status.lines).toBe(1);
    exec.output("stderr", "second\n");
    exec.output("stdout", "tail");
    exec.finish(9);
    await until(() => record.status.state === "exited");
    const lines = [];
    for await (const line of service.runs.output(runId, 1)) lines.push(line);
    expect(lines).toEqual([{ n: 1, stream: "stderr", line: "second" }, { n: 2, stream: "stdout", line: "tail" }]);
    expect(JSON.parse(await readFile(join(config.dataRoot, `runs/${runId}.json`), "utf8"))).toMatchObject({ status: { lines: 3, state: "exited", exitCode: 9 } });
    await expect(service.startRun(agent(), StartRunRequest.parse(runRequest))).rejects.toMatchObject({ code: "run_exists" });
  });

  it("writes image blocks to CLI stdin for new and resumed sessions", async () => {
    const images = [{ mediaType: "image/png", data: "aW1hZ2U=" }];
    for (const resume of [false, true]) {
      const request = StartRunRequest.parse({ ...runRequest, runId: resume ? otherRunId : runId, resume, images });
      await service.startRun(agent(), request);
      const exec = [...executions.values()].at(-1)!;
      expect(exec.input).toBe(claudeUserMessage(request.prompt, request.images));
      expect(JSON.parse(exec.input).message.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } });
      expect(exec.body.Cmd).toContain("--input-format");
      await until(() => service.run(request.runId).status.state === "exited");
    }
  });

  it("accepts a large start-run JSON body while the file route keeps its smaller limit", async () => {
    const router = new SupervisorServer(service);
    await router.initialize();
    try {
      const input = { ...runRequest, images: Array.from({ length: 8 }, () => ({ mediaType: "image/png", data: "a".repeat(5 * 1024 * 1024) })) };
      expect((await memoryRequest(router, "POST", `/v1/agents/${agentId}/runs`, input)).statusCode).toBe(202);
      expect((await memoryRequest(router, "POST", `/v1/agents/${agentId}/files`, input)).statusCode).toBe(413);
    } finally { await router.close(); }
  });

  it.each(["starting", "running"] as const)("cancels an orphaned %s run and closes owner shells before admitting requests", async (state) => {
    await service.start(agent());
    const record = storedRun(state, "orphan");
    await service.runs.reserve(record);
    await service.runs.append(record, [{ stream: "stdout", line: "recorded before outage" }]);
    const original = new ScriptedExec({ hold: true }, { Cmd: claudeTaskArgv(StartRunRequest.parse(runRequest)), User: "1000:1000", AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false });
    executions.set("orphan", original);
    plans.push({ hold: true }, { hold: true });
    const logs = vi.spyOn(service, "log");
    const router = new SupervisorServer(service);
    const initializing = router.initialize();
    try {
      await until(() => [...executions.values()].some((exec) => exec.body.Cmd[0] === CLI_PATHS.cancelWrapper));
      const canceller = [...executions.values()].find((exec) => exec.body.Cmd[0] === CLI_PATHS.cancelWrapper)!;
      expect(original.state.Running).toBe(true);
      expect(canceller.body.Cmd).toEqual([CLI_PATHS.cancelWrapper, runId]);
      expect((await memoryRequest(router, "GET", "/health")).statusCode).toBe(401);
      expect(service.run(runId).status.state).toBe(state);
      original.finish(143);
      canceller.finish(0);
      await until(() => [...executions.values()].some((exec) => exec.body.Cmd[0] === CLI_PATHS.closeOwnerShell));
      expect((await memoryRequest(router, "POST", `/v1/agents/${agentId}/runs`, { ...runRequest, runId: otherRunId })).statusCode).toBe(401);
      [...executions.values()].find((exec) => exec.body.Cmd[0] === CLI_PATHS.closeOwnerShell)!.finish(0);
      await initializing;
      expect((await memoryRequest(router, "GET", "/health")).statusCode).toBe(200);
      expect(service.run(runId).status).toMatchObject({ state: "lost", exitCode: null, lines: 1, endedAt: expect.any(String) });
      expect(JSON.parse(await readFile(join(config.dataRoot, `runs/${runId}.json`), "utf8"))).toMatchObject({ status: { state: "lost", exitCode: null } });
      expect(service.docker.inspectExec).not.toHaveBeenCalledWith("orphan");
      expect(service.docker.startExec).not.toHaveBeenCalledWith("orphan", expect.anything());
      expect([...executions.values()].filter((exec) => exec.body.Cmd[0] === CLI_PATHS.closeOwnerShell)).toHaveLength(1);
      for (const event of ["startup_cancel_run", "startup_run_lost", "startup_close_owner_shell"]) expect(logs).toHaveBeenCalledWith(expect.objectContaining({ event, agentId }));
    } finally { await router.close(); }
  });

  it.each([null, "missing", "finished"])("marks interrupted runs lost regardless of recorded exec status: %s", async (execId) => {
    await service.start(agent());
    await service.runs.reserve(storedRun("running", execId));
    if (execId === "finished") {
      const exec = new ScriptedExec({}, { Cmd: [], User: "1000:1000", AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false });
      exec.finish(11);
      executions.set(execId, exec);
    }
    await service.initialize();
    expect(service.run(runId).status).toMatchObject({ state: "lost", exitCode: null });
    expect(service.docker.inspectExec).not.toHaveBeenCalledWith(execId);
    expect(service.docker.createExec).toHaveBeenCalledWith("qb-cli-1", expect.objectContaining({ Cmd: [CLI_PATHS.cancelWrapper, runId] }));
  });

  it.each(["stopped", "missing"])("does not execute startup helpers in a %s CLI container", async (containerState) => {
    if (containerState === "stopped") { await service.start(agent()); await service.stop(agent()); }
    await service.runs.reserve(storedRun("starting", null));
    await service.initialize();
    expect(service.run(runId).status).toMatchObject({ state: "lost", exitCode: null });
    expect(service.docker.createExec).not.toHaveBeenCalled();
    expect(service.docker.inspectExec).not.toHaveBeenCalled();
  });

  it("closes owner shells at startup even when there is no recorded run", async () => {
    await service.start(agent());
    await service.initialize();
    expect(service.docker.createExec).toHaveBeenCalledWith("qb-cli-1", expect.objectContaining({ Cmd: [CLI_PATHS.closeOwnerShell], AttachStdin: false }));
    expect(service.docker.createExec).toHaveBeenCalledWith("qb-cli-1", expect.objectContaining({ Cmd: [CLI_PATHS.cancelSignIn], AttachStdin: false }));
  });

  it("parks the run records of a slot that is no longer configured and still starts", async () => {
    const hidden = { ...storedRun("running", null), status: { ...storedRun("running", null).status, agentId: "99999999-9999-4999-8999-999999999999" as never } };
    await service.runs.reserve(hidden);
    const logs = vi.spyOn(service, "log");
    await service.initialize();
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ event: "run_parked", runId }));
    expect(service.run(runId).status).toMatchObject({ state: "running" });
  });

  it.each([126, 127])("starts when a CLI container from an older image has no sign-in helper (exit %s)", async (exitCode) => {
    await service.start(agent());
    plans.push({ exitCode: 0 }, { exitCode });
    const logs = vi.spyOn(service, "log");
    await service.initialize();
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ event: "startup_sign_in_helper_missing", exitCode }));
  });

  it("refuses to start when the sign-in helper fails", async () => {
    await service.start(agent());
    plans.push({ exitCode: 0 }, { exitCode: 3 });
    await expect(service.initialize()).rejects.toThrow("Startup sign-in cancellation failed");
  });

  it("marks a run lost when the cancel wrapper confirms this sandbox never started it", async () => {
    await service.start(agent());
    await service.runs.reserve(storedRun("starting", null));
    plans.push({ exitCode: 3 });
    const logs = vi.spyOn(service, "log");
    await service.initialize();
    expect(service.run(runId).status).toMatchObject({ state: "lost", exitCode: null });
    expect(logs).toHaveBeenCalledWith({ event: "startup_cancel_run_finished", agentId, runId, exitCode: 3 });
    expect(service.docker.createExec).toHaveBeenCalledTimes(3);
  });

  it.each(["cancel", "owner shell"])("refuses requests if startup %s cleanup fails", async (operation) => {
    await service.start(agent());
    if (operation === "cancel") await service.runs.reserve(storedRun("running", "orphan"));
    plans.push({ exitCode: 1 });
    const router = new SupervisorServer(service);
    try {
      await expect(router.initialize()).rejects.toThrow(operation === "cancel" ? "Startup cancellation failed" : "Startup owner shell closure failed");
      expect((await memoryRequest(router, "GET", "/health")).statusCode).toBe(401);
      if (operation === "cancel") expect(service.run(runId).status.state).toBe("running");
    } finally { await router.close(); }
  });

  it("caps each exec stream at its tail and uses only the tools sandbox", async () => {
    plans.push({ stdout: "discard" + "a".repeat(LIMITS.execOutputChars), stderr: "b".repeat(LIMITS.execOutputChars + 1), exitCode: 137 });
    const result = await service.exec(agent(), { execId: "exec-test-01", command: "something private", cwd: "dir", timeoutS: 2 });
    expect(result).toEqual({ execId: "exec-test-01", stdout: "a".repeat(LIMITS.execOutputChars), stderr: "b".repeat(LIMITS.execOutputChars), exitCode: 137, timedOut: true, truncated: true });
    expect(service.docker.createExec).toHaveBeenCalledWith("qb-tools-1", expect.objectContaining({ Cmd: ["timeout", "--signal=KILL", "2s", "bash", "-lc", "something private"], WorkingDir: "/workspace/dir", User: "1000:1000" }));
    await service.resetTools(agent());
    expect(executions.get("e2")!.body.Cmd).toEqual([TOOLS_PATHS.resetTools]);
  });

  it("validates helper output and spools binary exports before reporting helper errors", async () => {
    await service.start(agent());
    const input = { op: "write" as const, path: "invoice.txt", content: "private file" };
    plans.push({ stdout: JSON.stringify({ op: "write", bytes: 12 }) });
    expect(await service.files(agent(), input)).toEqual({ op: "write", bytes: 12 });
    expect(executions.get("e1")!.input).toBe(JSON.stringify(input));
    plans.push({ stdout: '{"op":"write","bytes":"bad"}' });
    await expect(service.files(agent(), input)).rejects.toMatchObject({ code: "invalid_helper_output" });
    const bytes = Buffer.from([0, 255, 4, 5, 9, 128]);
    plans.push({ stdout: bytes });
    const exported = await service.exportFile(agent(), { scope: "workspace", path: "invoice.pdf" });
    expect(await readFile(exported.path)).toEqual(bytes);
    expect(executions.get("e3")!.body.Cmd).toEqual(["/opt/quokkabot/bin/qb-files", "export"]);
    await exported.dispose();
    expect(existsSync(exported.path)).toBe(false);
    plans.push({ stdout: "partial", stderr: "not_found: absent\nsecret diagnostic", exitCode: 1 });
    await expect(service.exportFile(agent(), { scope: "downloads", path: "gone" })).rejects.toMatchObject({ status: 404, message: "not_found: absent" });
    const missing = { op: "error", code: "not_found", message: "File is missing" };
    plans.push({ stdout: JSON.stringify(missing), exitCode: 1 });
    expect(await service.files(agent(), { op: "read", scope: "workspace", path: "missing" })).toEqual(missing);
  });

  it.each(["missing", "created", "exited"] as const)("answers computer_stopped for file work when the tools sandbox is %s, without an exec or a start", async (state) => {
    if (state !== "missing") {
      await service.start(agent());
      if (state === "exited") await service.stop(agent());
      else containers.get("qb-tools-1")!.State = { Running: false, Status: "created", StartedAt: "0001-01-01T00:00:00Z" };
    }
    operations.length = 0;
    await expect(service.files(agent(), { op: "list", scope: "workspace", dir: "" })).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(service.files(agent(), { op: "list", scope: "downloads", dir: "" })).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    await expect(service.exportFile(agent(), { scope: "workspace", path: "invoice.pdf" })).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
    expect(service.docker.createExec).not.toHaveBeenCalled();
    expect(operations.every((operation) => operation === "inspect:qb-tools-1")).toBe(true);
    // The export spool is removed with the refusal.
    expect((await readdir(service.runs.root)).filter((name) => name.startsWith(".export-"))).toEqual([]);
    const router = new SupervisorServer(service);
    await router.initialize();
    try {
      const response = await memoryRequest(router, "POST", `/v1/agents/${agentId}/files`, { op: "list", scope: "workspace", dir: "" });
      expect(response.statusCode).toBe(409);
      expect(JSON.parse(Buffer.concat(response.chunks).toString())).toEqual({ error: "computer_stopped", message: "The computer is stopped" });
    } finally { await router.close(); }
  });

  it.each(["stop", "kill"] as const)("answers a listing and an export that a %s ends mid-way like one that came after it", async (action) => {
    await service.start(agent());
    plans.push({ hold: true }, { hold: true });
    const listing = service.files(agent(), { op: "list", scope: "workspace", dir: "" });
    const exporting = service.exportFile(agent(), { scope: "workspace", path: "invoice.pdf" });
    await until(() => executions.size === 2);
    // The helpers run outside the lifecycle lock: the stop or kill does not wait for them.
    await (action === "stop" ? service.stop(agent()) : service.kill(agent()));
    executions.get("e1")!.output("stdout", '{"op":"li');
    for (const exec of executions.values()) exec.finish(137);
    const expected = action === "stop" ? { status: 409, code: "computer_stopped" } : { status: 409, code: "killed" };
    await expect(listing).rejects.toMatchObject(expected);
    await expect(exporting).rejects.toMatchObject(expected);
    expect((await readdir(service.runs.root)).filter((name) => name.startsWith(".export-"))).toEqual([]);
  });

  it("keeps the stop's answer when a start comes before the helper ends", async () => {
    await service.start(agent());
    plans.push({ hold: true });
    const listing = service.files(agent(), { op: "list", scope: "workspace", dir: "" });
    await until(() => executions.size === 1);
    await service.stop(agent());
    await service.start(agent());
    executions.get("e1")!.finish(137);
    await expect(listing).rejects.toMatchObject({ status: 409, code: "computer_stopped" });
  });

  it("forgets a stop that came and went while the request waited for the lifecycle lock", async () => {
    await service.start(agent());
    plans.push({ stdout: '{"op":"li', exitCode: 137 });
    const stopping = service.stop(agent());
    const starting = service.start(agent());
    const listing = service.files(agent(), { op: "list", scope: "workspace", dir: "" });
    await Promise.all([stopping, starting]);
    await expect(listing).rejects.toMatchObject({ status: 502, code: "invalid_helper_output" });
  });

  it("keeps a helper failure an error while the computer runs, and when the tools sandbox dies on its own", async () => {
    await service.start(agent());
    plans.push({ stdout: '{"op":"li', exitCode: 137 }, { stdout: "partial", exitCode: 137 });
    await expect(service.files(agent(), { op: "list", scope: "workspace", dir: "" })).rejects.toMatchObject({ status: 502, code: "invalid_helper_output" });
    await expect(service.exportFile(agent(), { scope: "workspace", path: "invoice.pdf" })).rejects.toMatchObject({ status: 400, code: "export_failed" });
    plans.push({ hold: true });
    const listing = service.files(agent(), { op: "list", scope: "workspace", dir: "" });
    await until(() => executions.size === 3);
    // A crash outside the supervisor: no stop or kill was asked for.
    Object.assign(containers.get("qb-tools-1")!.State, { Running: false, Status: "exited" });
    executions.get("e3")!.finish(137);
    await expect(listing).rejects.toMatchObject({ status: 502, code: "invalid_helper_output" });
  });

  it("keeps the kill latch and any other tools sandbox state ahead of file work", async () => {
    await service.start(agent());
    containers.get("qb-tools-1")!.State.Status = "paused";
    await expect(service.files(agent(), { op: "list", scope: "workspace", dir: "" })).rejects.toMatchObject({ status: 502, code: "tools_unavailable" });
    containers.get("qb-tools-1")!.State.Status = "running";
    await service.kill(agent());
    await expect(service.files(agent(), { op: "list", scope: "workspace", dir: "" })).rejects.toMatchObject({ status: 409, code: "killed" });
    await expect(service.exportFile(agent(), { scope: "workspace", path: "invoice.pdf" })).rejects.toMatchObject({ status: 409, code: "killed" });
    expect(service.docker.createExec).not.toHaveBeenCalled();
    await service.unlatch(agent());
    containers.get("qb-tools-1")!.Config.Labels = { ...containers.get("qb-tools-1")!.Config.Labels, "quokkabot.agent": "99999999-9999-4999-8999-999999999999" };
    await expect(service.files(agent(), { op: "list", scope: "workspace", dir: "" })).rejects.toThrow("Container qb-tools-1 does not belong to this agent");
    expect(service.docker.createExec).not.toHaveBeenCalled();
  });

  it("cancels via a fixed wrapper and waits for original exit before cleanup", async () => {
    plans.push({ hold: true });
    await service.startRun(agent(), StartRunRequest.parse(runRequest));
    const record = service.run(runId);
    await expect(service.cleanup(agent(), runId, sessionId)).rejects.toMatchObject({ code: "busy" });
    expect((await service.cancel(record)).state).toBe("running");
    expect(executions.get("e2")!.body.Cmd).toEqual([CLI_PATHS.cancelWrapper, runId]);
    executions.get("e1")!.finish(143);
    await until(() => record.status.state === "cancelled");
    await service.cleanup(agent(), runId, sessionId);
    expect(executions.get("e3")!.body.Cmd).toEqual([CLI_PATHS.cleanupSession, sessionId]);
    expect(existsSync(join(config.dataRoot, "agents/1/run/mcp.json"))).toBe(false);
  });

  it("refuses active cleanup, retains files on helper failure, then deletes output and status idempotently", async () => {
    const router = new SupervisorServer(service);
    await router.initialize();
    const cleanupPath = `/v1/agents/${agentId}/runs/${runId}/cleanup`;
    const statusPath = join(config.dataRoot, `runs/${runId}.json`);
    const outputPath = join(config.dataRoot, `runs/${runId}.ndjson`);
    try {
      plans.push({ hold: true });
      await service.startRun(agent(), StartRunRequest.parse(runRequest));
      const original = executions.get("e1")!;
      original.output("stdout", "private tool input\nprivate tool result\n");
      await until(() => service.run(runId).status.lines === 2);
      expect((await memoryRequest(router, "POST", cleanupPath, { sessionId })).statusCode).toBe(409);
      await service.runs.updateStatus(service.run(runId), { state: "starting" });
      expect((await memoryRequest(router, "POST", cleanupPath, { sessionId })).statusCode).toBe(409);
      expect(service.docker.createExec).toHaveBeenCalledTimes(1);
      original.finish(0);
      await until(() => service.run(runId).status.state === "exited");
      plans.push({ exitCode: 1 });
      expect((await memoryRequest(router, "POST", cleanupPath, { sessionId })).statusCode).toBe(502);
      expect(existsSync(statusPath)).toBe(true);
      expect(await readFile(outputPath, "utf8")).toContain("private tool result");
      expect((await memoryRequest(router, "POST", cleanupPath, { sessionId })).statusCode).toBe(200);
      expect(existsSync(statusPath)).toBe(false);
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(join(config.dataRoot, "agents/1/run/mcp.json"))).toBe(false);
      expect((await memoryRequest(router, "GET", `/v1/runs/${runId}`)).statusCode).toBe(404);
      expect((await memoryRequest(router, "GET", `/v1/runs/${runId}/output`)).statusCode).toBe(404);
      const restartedStore = new RunStore(service.runs.root);
      await restartedStore.load();
      expect(restartedStore.records.has(runId)).toBe(false);
      plans.push({ hold: true });
      await service.startRun(agent(), StartRunRequest.parse({ ...runRequest, runId: otherRunId }));
      const callsBeforeRetry = executions.size;
      const nextMcp = await readFile(join(config.dataRoot, "agents/1/run/mcp.json"), "utf8");
      expect((await memoryRequest(router, "POST", cleanupPath, { sessionId })).statusCode).toBe(200);
      expect(executions.size).toBe(callsBeforeRetry);
      expect(await readFile(join(config.dataRoot, "agents/1/run/mcp.json"), "utf8")).toBe(nextMcp);
    } finally { await router.close(); }
  });

  it("reserves a raw terminal and releases its exclusivity explicitly", async () => {
    plans.push({ hold: true });
    const terminal = await service.openTerminal(agent());
    expect(executions.get("e1")!.body).toMatchObject({ Cmd: [CLI_PATHS.ownerShell], Tty: true, Env: [...cliEnvironment(agent()), "TERM=xterm-256color"] });
    await expect(service.openTerminal(agent())).rejects.toMatchObject({ code: "busy" });
    await expect(service.startRun(agent(), StartRunRequest.parse(runRequest))).rejects.toMatchObject({ code: "busy" });
    // Releasing runs the close helper; the slot stays taken until it has finished.
    plans.push({ hold: true });
    terminal.stream.destroy(); terminal.release();
    await until(() => [...executions.values()].some((e) => e.body.Cmd?.[0] === CLI_PATHS.closeOwnerShell));
    const closer = [...executions.values()].find((e) => e.body.Cmd?.[0] === CLI_PATHS.closeOwnerShell)!;
    await expect(service.startRun(agent(), StartRunRequest.parse(runRequest))).rejects.toMatchObject({ code: "busy" });
    closer.finish(0);
    await until(() => !service.terminalsBusy(agent()));
    plans.push({ stdout: "done\n" });
    await service.startRun(agent(), StartRunRequest.parse(runRequest));
    await until(() => service.run(runId).status.state === "exited");
  });

  it("validates authenticated HTTP routes and strict request bodies without binding a socket", async () => {
    const router = new SupervisorServer(service);
    await router.initialize();
    try {
      expect((await memoryRequest(router, "GET", "/health", undefined, "bad-token")).statusCode).toBe(401);
      expect((await memoryRequest(router, "GET", "/health")).statusCode).toBe(200);
      expect((await memoryRequest(router, "GET", "/v1/agents/99999999-9999-4999-8999-999999999999/computer")).statusCode).toBe(404);
      const prefix = `/v1/agents/${agentId}`;
      expect((await memoryRequest(router, "POST", `${prefix}/computer/start`, { unknown: "field" })).statusCode).toBe(400);
      expect((await memoryRequest(router, "POST", `${prefix}/runs`, { ...runRequest, extra: true })).statusCode).toBe(400);
      expect((await memoryRequest(router, "POST", `${prefix}/exec`, { execId: "test-exec", command: "pwd", cwd: "../", timeoutS: 2 })).statusCode).toBe(400);
      expect((await memoryRequest(router, "POST", `${prefix}/files`, { op: "stat", scope: "workspace", path: "a", extra: true })).statusCode).toBe(400);
      expect((await memoryRequest(router, "POST", `${prefix}/computer/start`)).statusCode).toBe(200);
      expect((await memoryRequest(router, "POST", `${prefix}/computer/kill`)).statusCode).toBe(200);
      const latched = await memoryRequest(router, "POST", `${prefix}/computer/start`);
      expect(latched.statusCode).toBe(409);
      expect(JSON.parse(Buffer.concat(latched.chunks).toString())).toMatchObject({ error: "killed" });
      expect((await memoryRequest(router, "POST", `${prefix}/computer/unlatch`)).statusCode).toBe(200);
      plans.push({ stdout: "one\ntwo\n" });
      expect((await memoryRequest(router, "POST", `${prefix}/runs`, runRequest)).statusCode).toBe(202);
      await until(() => service.run(runId).status.state === "exited");
      const output = await memoryRequest(router, "GET", `/v1/runs/${runId}/output?from=1`);
      expect(Buffer.concat(output.chunks).toString()).toBe(JSON.stringify({ n: 1, stream: "stdout", line: "two" }) + "\n");
      expect((await memoryRequest(router, "GET", `/v1/runs/${runId}/output?wait=26`)).statusCode).toBe(400);
      expect((await memoryRequest(router, "GET", `/v1/runs/${runId}/output?from=0&from=1`)).statusCode).toBe(400);
    } finally { await router.close(); }
  });

  it("kills and latches the computer when the CLI recorder receives invalid stream framing", async () => {
    await service.start(agent());
    plans.push({ hold: true });
    await service.startRun(agent(), StartRunRequest.parse(runRequest));
    executions.get("e1")!.push(Buffer.alloc(8, 7));
    await until(() => service.run(runId).status.state === "lost");
    expect((await service.status(agent())).killed).toBe(true);
    expect(operations.filter((operation) => operation.startsWith("kill:"))).toHaveLength(3);
  });

  it("completes a persisted kill latch before accepting operations after restart", async () => {
    await service.start(agent());
    await atomicWrite(join(config.dataRoot, "agents/1/killed.json"), JSON.stringify({ killedAt: new Date().toISOString() }));
    requireLatch = true;
    await service.initialize();
    expect(operations.filter((operation) => operation.startsWith("kill:"))).toHaveLength(3);
    await expect(service.start(agent())).rejects.toMatchObject({ code: "killed" });
  });

  it("allows kill to interrupt a hanging session cleanup without admitting a new run", async () => {
    await service.start(agent());
    plans.push({ stdout: "done\n" });
    await service.startRun(agent(), StartRunRequest.parse(runRequest));
    await until(() => service.run(runId).status.state === "exited");
    plans.push({ hold: true });
    const cleanup = service.cleanup(agent(), runId, sessionId);
    const failed = expect(cleanup).rejects.toMatchObject({ code: "cleanup_failed" });
    await until(() => executions.has("e2"));
    await expect(service.startRun(agent(), StartRunRequest.parse({ ...runRequest, runId: otherRunId }))).rejects.toMatchObject({ code: "busy" });
    expect((await service.kill(agent())).killed).toBe(true);
    executions.get("e2")!.finish(137);
    await failed;
  });
});

describe.skipIf(!canListen)("supervisor unix socket API with fake Docker", () => {
  let root: string;
  let config: SupervisorConfig;
  let docker: FakeDocker;
  let server: SupervisorServer;
  let ownership: string[];
  let logs: Array<Record<string, unknown>>;
  const agentUrl = `/v1/agents/${agentId}`;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qb-test-"));
    config = configuration(root);
    await prepare(config);
    docker = new FakeDocker(config.dockerSocket);
    await docker.listen();
    ownership = [];
    logs = [];
    server = await createServer(config, { own: async (path) => { ownership.push(path); }, log: (event) => { logs.push(event); } });
  });
  afterEach(async () => { await server?.close(); await docker?.close(); if (root) await rm(root, { recursive: true, force: true }); });
  async function start(): Promise<void> { expect((await request(config, "POST", `${agentUrl}/computer/start`)).status).toBe(200); }
  const execInput = { execId: "exec-test-01", command: "printf private-output", cwd: "subdir", timeoutS: 5 };

  it("enforces the marker, socket permissions, auth, unknown agents and strict bodies", async () => {
    expect((await stat(config.socketPath)).mode & 0o777).toBe(0o660);
    expect((await request(config, "GET", "/health", undefined, "wrong")).status).toBe(401);
    expect((await request(config, "GET", "/health")).status).toBe(200);
    expect((await request(config, "GET", `${agentUrl}/computer`, undefined, "wrong")).status).toBe(401);
    expect((await request(config, "GET", "/v1/agents/99999999-9999-4999-8999-999999999999/computer")).status).toBe(404);
    expect((await request(config, "POST", `${agentUrl}/computer/start`, { surprise: true })).status).toBe(400);
    expect((await request(config, "POST", `${agentUrl}/exec`, { ...execInput, Image: "host" })).status).toBe(400);
    expect(docker.calls.map((call) => ({ method: call.method, path: call.path }))).toEqual([{ method: "GET", path: "/v1.47/containers/qb-cli-1/json" }]);
    await server.close();
    await unlink(join(config.dataRoot, config.dataMarker));
    await expect(createServer(config, { own: async () => undefined })).rejects.toThrow("marker is missing");
  });

  it("creates internal networks and starts browser, tools, cli with fixed templates", async () => {
    await start();
    const creates = docker.calls.filter((call) => call.path.startsWith("/v1.47/containers/create"));
    expect(creates.map((call) => call.body)).toEqual([containerBody(config, config.agents[0]!, "browser", { selkies: "selkies-secret", browser: "browser-secret" }), containerBody(config, config.agents[0]!, "tools"), containerBody(config, config.agents[0]!, "cli")]);
    expect(docker.calls.filter((call) => call.path.endsWith("/start")).map((call) => call.path)).toEqual(["/v1.47/containers/qb-browser-1/start", "/v1.47/containers/qb-tools-1/start", "/v1.47/containers/qb-cli-1/start"]);
    expect((await request(config, "GET", `${agentUrl}/computer`)).json).toMatchObject({ killed: false, sandboxes: [{ name: "cli", state: "running", memoryBytes: 1024 }, { name: "tools", state: "running" }, { name: "browser", state: "running" }] });
    const count = creates.length;
    await start();
    expect(docker.calls.filter((call) => call.path.startsWith("/v1.47/containers/create"))).toHaveLength(count);
    docker.containers.get("qb-cli-1")!.Config.Image = image("old-cli");
    await start();
    expect(docker.calls.some((call) => call.method === "DELETE" && call.path === "/v1.47/containers/qb-cli-1?force=true")).toBe(true);
    expect((await request(config, "POST", `${agentUrl}/computer/stop`)).status).toBe(200);
    expect(docker.calls.filter((call) => call.path.includes("/stop?")).map((call) => call.path)).toEqual(["/v1.47/containers/qb-cli-1/stop?t=20", "/v1.47/containers/qb-tools-1/stop?t=20", "/v1.47/containers/qb-browser-1/stop?t=20"]);
  });

  it("durably latches before Docker, disconnects before kills, refuses starts, and unlatches", async () => {
    await start();
    docker.calls.length = 0;
    docker.onCall = () => { expect(existsSync(join(config.dataRoot, "agents/1/killed.json"))).toBe(true); };
    const result = await request(config, "POST", `${agentUrl}/computer/kill`);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ killed: true });
    const paths = docker.calls.map((call) => call.path);
    const disconnects = paths.flatMap((path, index) => path.endsWith("/disconnect") ? [index] : []);
    const kills = paths.flatMap((path, index) => path.includes("/kill?") ? [index] : []);
    expect(disconnects).toHaveLength(2);
    expect(kills).toHaveLength(3);
    expect(Math.max(...disconnects)).toBeLessThan(Math.min(...kills));
    expect((await request(config, "POST", `${agentUrl}/computer/start`)).json).toMatchObject({ error: "killed" });
    expect((await request(config, "POST", `${agentUrl}/runs`, runRequest)).status).toBe(409);
    expect((await request(config, "POST", `${agentUrl}/computer/kill`)).status).toBe(200);
    delete docker.onCall;
    expect((await request(config, "POST", `${agentUrl}/computer/unlatch`)).json).toMatchObject({ killed: false });
    await start();
    expect(docker.containers.get("qb-cli-1")!.NetworkSettings.Networks["qb-cli-1"]?.IPAddress).toBe("10.231.1.10");
  });

  it("still kills all sandboxes and preserves the latch when a disconnect fails", async () => {
    await start();
    docker.calls.length = 0;
    docker.fail = (call) => call.path.endsWith("/disconnect") ? 500 : undefined;
    expect((await request(config, "POST", `${agentUrl}/computer/kill`)).status).toBe(502);
    expect(docker.calls.filter((call) => call.path.includes("/kill?"))).toHaveLength(3);
    expect(JSON.parse(await readFile(join(config.dataRoot, "agents/1/killed.json"), "utf8"))).toHaveProperty("killedAt");
  });

  it("runs the shared argv with private stdin, records both streams and long-polls from an offset", async () => {
    await start();
    docker.plans.push({ hold: true, headOutput: "first\n" });
    const started = await request(config, "POST", `${agentUrl}/runs`, runRequest);
    expect(started.status).toBe(202);
    const exec = [...docker.execs.values()][0]!;
    await until(() => exec.input.toString() === claudeUserMessage(runRequest.prompt));
    expect(exec.body).toEqual({ Cmd: claudeTaskArgv(StartRunRequest.parse(runRequest)), User: "1000:1000", AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Env: cliEnvironment(config.agents[0]!), WorkingDir: CLI_PATHS.workdir });
    const mcpPath = join(config.dataRoot, "agents/1/run/mcp.json");
    expect((await stat(mcpPath)).mode & 0o777).toBe(0o600);
    expect(ownership.some((path) => path.startsWith(mcpPath))).toBe(true);
    expect(JSON.parse(await readFile(mcpPath, "utf8"))).toMatchObject({ mcpServers: { quokkabot: { url: "http://10.231.1.3:8090/mcp", headers: { Authorization: `Bearer ${runRequest.mcpToken}` } } } });
    await until(() => server.supervisor.run(runId).status.lines === 1);
    expect((await request(config, "POST", `${agentUrl}/runs`, { ...runRequest, runId: otherRunId })).status).toBe(409);
    const polling = request(config, "GET", `/v1/runs/${runId}/output?from=1&wait=2`);
    await delay(25);
    docker.output(exec, "stderr", "second\n");
    expect((await polling).text).toBe(JSON.stringify({ n: 1, stream: "stderr", line: "second" }) + "\n");
    docker.output(exec, "stdout", "third");
    docker.finish(exec, 7);
    await until(() => server.supervisor.run(runId).status.state === "exited");
    expect((await request(config, "GET", `/v1/runs/${runId}`)).json).toMatchObject({ state: "exited", exitCode: 7, lines: 3 });
    expect((await request(config, "GET", `/v1/runs/${runId}/output?from=2`)).text).toBe(JSON.stringify({ n: 2, stream: "stdout", line: "third" }) + "\n");
    expect((await request(config, "POST", `${agentUrl}/runs`, runRequest)).status).toBe(409);
    expect((await readFile(join(config.dataRoot, `runs/${runId}.ndjson`), "utf8")).split("\n")).toHaveLength(4);
    expect(JSON.stringify(logs)).not.toContain(runRequest.prompt);
    expect(JSON.stringify(logs)).not.toContain(runRequest.mcpToken);
    expect((await request(config, "GET", `/v1/runs/${runId}/output?wait=26`)).status).toBe(400);
    expect((await request(config, "GET", `/v1/runs/${runId}/output?from=0&from=1`)).status).toBe(400);
  });

  it("cancels surviving runs and closes owner shells before serving requests after restart", async () => {
    await start();
    docker.plans.push({ hold: true });
    expect((await request(config, "POST", `${agentUrl}/runs`, runRequest)).status).toBe(202);
    const original = [...docker.execs.values()][0]!;
    await until(() => original.input.length > 0);
    await server.close();
    expect(original.running).toBe(true);
    docker.plans.push({ hold: true }, { hold: true });
    const restarting = createServer(config, { own: async () => undefined, log: (event) => { logs.push(event); } });
    await until(() => [...docker.execs.values()].some((exec) => exec.body.Cmd[0] === CLI_PATHS.cancelWrapper && exec.running));
    const canceller = [...docker.execs.values()].find((exec) => exec.body.Cmd[0] === CLI_PATHS.cancelWrapper)!;
    expect(canceller.body.Cmd).toEqual([CLI_PATHS.cancelWrapper, runId]);
    expect((await request(config, "GET", "/health")).status).toBe(401);
    docker.finish(original, 143);
    docker.finish(canceller, 0);
    await until(() => [...docker.execs.values()].some((exec) => exec.body.Cmd[0] === CLI_PATHS.closeOwnerShell && exec.running));
    expect((await request(config, "POST", `${agentUrl}/runs`, { ...runRequest, runId: otherRunId })).status).toBe(401);
    const closer = [...docker.execs.values()].find((exec) => exec.body.Cmd[0] === CLI_PATHS.closeOwnerShell)!;
    docker.finish(closer, 0);
    server = await restarting;
    expect((await request(config, "GET", "/health")).status).toBe(200);
    expect((await request(config, "GET", `/v1/runs/${runId}`)).json).toMatchObject({ state: "lost", exitCode: null });
    expect(docker.calls.filter((call) => call.path === `/v1.47/exec/${original.id}/start`)).toHaveLength(1);
    expect(logs).toContainEqual({ event: "startup_run_lost", agentId, runId });
  });

  it("cancels through the fixed wrapper, observes exit, and cleans the session and MCP file", async () => {
    await start();
    docker.plans.push({ hold: true });
    await request(config, "POST", `${agentUrl}/runs`, runRequest);
    const original = [...docker.execs.values()][0]!;
    docker.output(original, "stdout", "private input and result\n");
    await until(() => server.supervisor.run(runId).status.lines === 1);
    expect((await request(config, "POST", `${agentUrl}/runs/${runId}/cleanup`, { sessionId })).status).toBe(409);
    expect((await request(config, "POST", `/v1/runs/${runId}/cancel`)).status).toBe(200);
    expect([...docker.execs.values()][1]!.body.Cmd).toEqual([CLI_PATHS.cancelWrapper, runId]);
    expect(server.supervisor.run(runId).status.state).toBe("running");
    docker.finish(original, 143);
    await until(() => server.supervisor.run(runId).status.state === "cancelled");
    expect((await request(config, "POST", `${agentUrl}/runs/${runId}/cleanup`, { sessionId })).status).toBe(200);
    expect([...docker.execs.values()][2]!.body.Cmd).toEqual([CLI_PATHS.cleanupSession, sessionId]);
    expect(existsSync(join(config.dataRoot, "agents/1/run/mcp.json"))).toBe(false);
    expect(existsSync(join(config.dataRoot, `runs/${runId}.ndjson`))).toBe(false);
    expect(existsSync(join(config.dataRoot, `runs/${runId}.json`))).toBe(false);
    expect((await request(config, "GET", `/v1/runs/${runId}`)).status).toBe(404);
    expect((await request(config, "POST", `${agentUrl}/runs/${runId}/cleanup`, { sessionId })).status).toBe(200);
    expect(docker.execs.size).toBe(3);
  });

  it("decodes exec output, keeps per-stream tails, reports timeout and uses fixed commands", async () => {
    await start();
    docker.plans.push({ stdout: "start" + "A".repeat(LIMITS.execOutputChars), stderr: "X".repeat(LIMITS.execOutputChars + 1), exitCode: 137 });
    const result = await request(config, "POST", `${agentUrl}/exec`, execInput);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ execId: execInput.execId, stdout: "A".repeat(LIMITS.execOutputChars), stderr: "X".repeat(LIMITS.execOutputChars), truncated: true, exitCode: 137, timedOut: true });
    expect([...docker.execs.values()][0]!.body).toMatchObject({ Cmd: ["timeout", "--signal=KILL", "5s", "bash", "-lc", execInput.command], User: "1000:1000", WorkingDir: "/workspace/subdir" });
    expect((await request(config, "POST", `${agentUrl}/tools/reset`)).status).toBe(200);
    expect([...docker.execs.values()][1]!.body.Cmd).toEqual([TOOLS_PATHS.resetTools]);
    expect(JSON.stringify(logs)).toContain(`"commandLength":${execInput.command.length}`);
    expect(JSON.stringify(logs)).not.toContain(execInput.command);
  });

  it("passes JSON to the file helper, rejects invalid output, and exports exact binary bytes", async () => {
    await start();
    const input = { op: "write", path: "invoice.txt", content: "secret" };
    docker.plans.push({ stdout: JSON.stringify({ op: "write", bytes: 6 }) });
    expect((await request(config, "POST", `${agentUrl}/files`, input)).json).toEqual({ op: "write", bytes: 6 });
    expect([...docker.execs.values()][0]!.input.toString()).toBe(JSON.stringify(input));
    expect([...docker.execs.values()][0]!.body.Cmd).toEqual(["/opt/quokkabot/bin/qb-files"]);
    docker.plans.push({ stdout: "this is not JSON" });
    expect((await request(config, "POST", `${agentUrl}/files`, input)).json).toMatchObject({ error: "invalid_helper_output" });
    docker.plans.push({ stdout: JSON.stringify({ op: "write", bytes: "six" }) });
    expect((await request(config, "POST", `${agentUrl}/files`, input)).status).toBe(502);
    const binary = Buffer.from([0, 255, 18, 10, 13, 128]);
    docker.plans.push({ stdout: binary });
    const exported = await request(config, "POST", `${agentUrl}/files/export`, { scope: "workspace", path: "invoice.pdf" });
    expect(exported.headers["content-type"]).toBe("application/octet-stream");
    expect(exported.bytes).toEqual(binary);
    expect([...docker.execs.values()][3]!.input.toString()).toBe(JSON.stringify({ scope: "workspace", path: "invoice.pdf" }));
    docker.plans.push({ stdout: "partial", stderr: "not_found: missing\nprivate diagnostic", exitCode: 1 });
    const missing = await request(config, "POST", `${agentUrl}/files/export`, { scope: "downloads", path: "missing" });
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ message: "not_found: missing" });
  });

  function terminal() {
    // ws ignores a socketPath option (it overwrites it); unix sockets are addressed as ws+unix://<socket>:<path>.
    const ws = new WebSocket(`ws+unix://${config.socketPath}:${agentUrl}/terminal`, { headers: { Authorization: `Bearer ${token}` } });
    const frames: unknown[] = [];
    ws.on("message", (bytes) => frames.push(JSON.parse(bytes.toString()) as unknown));
    return { ws, frames, opened: new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); }) };
  }

  it("relays raw terminal data, forwards resize and excludes simultaneous runs and terminals", async () => {
    await start();
    docker.plans.push({ hold: true, echo: true, headOutput: "login: " });
    const live = terminal();
    await live.opened;
    const exec = [...docker.execs.values()][0]!;
    expect(exec.body).toMatchObject({ Cmd: [CLI_PATHS.ownerShell], User: "1000:1000", Tty: true, Env: [...cliEnvironment(config.agents[0]!), "TERM=xterm-256color"] });
    live.ws.send(JSON.stringify({ t: "in", d: "owner input\n" }));
    live.ws.send(JSON.stringify({ t: "resize", cols: 100, rows: 40 }));
    await until(() => exec.input.toString() === "owner input\n" && docker.calls.some((call) => call.path.endsWith("/resize?w=100&h=40")));
    await until(() => live.frames.some((frame) => (frame as { d?: string }).d?.includes("owner input")));
    expect((await request(config, "POST", `${agentUrl}/runs`, runRequest)).status).toBe(409);
    const second = terminal();
    await expect(second.opened).rejects.toThrow("409");
    // The close helper that runs when the terminal ends exits at once.
    docker.plans.push({ exitCode: 0 });
    docker.finish(exec, 0);
    await until(() => live.frames.some((frame) => (frame as { t: string }).t === "exit"));
    expect(live.frames).toContainEqual({ t: "exit", code: 0 });
    await until(() => live.ws.readyState === WebSocket.CLOSED);
    await until(() => [...docker.execs.values()].some((e) => e.body.Cmd?.[0] === CLI_PATHS.closeOwnerShell && !e.running));
    docker.plans.push({ hold: true });
    // The slot is freed once the close helper's exit has been observed; poll the API until a run is accepted.
    let accepted = 0;
    for (let i = 0; i < 40 && accepted !== 202; i += 1) {
      accepted = (await request(config, "POST", `${agentUrl}/runs`, runRequest)).status;
      if (accepted !== 202) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(accepted).toBe(202);
    const duringRun = terminal();
    await expect(duringRun.opened).rejects.toThrow("409");
  });

  // Closing the attach stream does not end the shell on a real Engine (see scripts/real-docker-smoke.ts).
  it("rejects extra terminal properties and closes the Docker exec stream when the owner disconnects", async () => {
    await start();
    docker.plans.push({ hold: true });
    const live = terminal();
    await live.opened;
    const exec = [...docker.execs.values()][0]!;
    live.ws.send(JSON.stringify({ t: "in", d: "input", surprise: true }));
    await until(() => live.ws.readyState === WebSocket.CLOSED);
    await until(() => exec.socket!.destroyed);
    expect(exec.input.length).toBe(0);
  });

  it("uses a real upgrade and exposes inspect, resize and network errors in the small Docker client", async () => {
    await start();
    const client = new Docker(config.dockerSocket);
    try {
      await expect(client.inspectExec("missing")).rejects.toMatchObject({ statusCode: 404 });
      docker.networks.get("qb-cli-1")!.Internal = false;
      expect((await request(config, "POST", `${agentUrl}/computer/start`)).status).toBe(502);
    } finally { client.close(); }
  });
});
