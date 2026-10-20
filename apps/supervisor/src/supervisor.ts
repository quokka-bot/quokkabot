import { randomUUID } from "node:crypto";
import { chown, readFile, open, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  ClaudeSignInStatus, claudeSignInError, CLI_PATHS, TOOLS_PATHS, LIMITS, claudeMcpConfig, claudeTaskArgv, claudeUserMessage, FilesResult,
} from "@quokkabot/shared";
import type { ClaudeSignInView, ComputerStatus, ExecRequest, ExecResult, FilesRequest, FilesExportRequest, RunStatus, StartRunRequest, SandboxName } from "@quokkabot/shared";
import { SupervisorConfig, requireDataMarker } from "./config.js";
import type { AgentConfig } from "./config.js";
import { Docker, DockerError, dockerMissing, dockerOutput } from "./docker.js";
import type { ContainerInspect, ExecCreate, ExecInspect } from "./docker.js";
import { agentPath, cliEnvironment, containerBody, containerName, networkBody, SANDBOXES } from "./templates.js";
import { writeWorkspaceBinary } from "./workspace.js";
import { atomicWrite, directory, durableRemove, emptyDirectory, requireDirectory, isMissing, RunStore } from "./storage.js";
import type { StoredRun } from "./storage.js";
import { readSignIn, within, type SignIn } from "./sign-in.js";
import { ClaudeTokenStore } from "./claude-token.js";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface SupervisorOptions {
  // Production runs as root. Tests can supply an ownership recorder without requiring host root.
  own?: (path: string) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
}
export interface Terminal { execId: string; stream: Duplex; release: () => void }
const KilledLatch = z.object({ killedAt: z.iso.datetime() }).strict();

export class Supervisor {
  readonly config: SupervisorConfig;
  readonly docker: Docker;
  readonly runs: RunStore;
  readonly claudeToken: ClaudeTokenStore;
  private readonly own: (path: string) => Promise<void>;
  readonly log: (event: Record<string, unknown>) => void;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly killing = new Set<string>();
  private readonly kills = new Map<string, Promise<ComputerStatus>>();
  private readonly terminals = new Set<string>();
  private readonly cleaning = new Set<string>();
  private readonly signIns = new Map<string, SignIn>();
  private readonly background = new Set<Promise<void>>();
  private closing = false;

  constructor(config: SupervisorConfig, options: SupervisorOptions = {}) {
    this.config = SupervisorConfig.parse(config);
    this.docker = new Docker(config.dockerSocket);
    this.runs = new RunStore(join(config.dataRoot, "runs"));
    this.claudeToken = new ClaudeTokenStore(join(config.dataRoot, "claude-sign-in"));
    this.own = options.own ?? ((path) => chown(path, 1000, 1000));
    this.log = options.log ?? ((event) => process.stdout.write(JSON.stringify(event) + "\n"));
  }

  async initialize(): Promise<void> {
    await requireDataMarker(this.config);
    await this.claudeToken.initialize();
    await directory(join(this.config.dataRoot, "agents"));
    for (const agent of this.config.agents) {
      await directory(agentPath(this.config, agent));
      // Host-owned agent parents cannot be swapped by sandbox processes.
      for (const name of ["cli-state", "run", "workspace", "browser-profile", "staging"]) {
        const path = agentPath(this.config, agent, name);
        await directory(path);
        await this.own(path);
      }
      // Downloads belong to the control plane, which publishes into them; the tools sandbox reads them through its
      // group. The installer sets their owner and mode; the supervisor only makes sure the directory exists.
      await directory(agentPath(this.config, agent, "downloads"));
    }
    await this.runs.load();
    for (const agent of this.config.agents) if (await this.latch(agent)) await this.kill(agent);
    // Records of slots above QUOKKABOT_AGENTS stay on disk untouched until the slot is provisioned again; the installer
    // refuses to hide a slot whose computer is running.
    for (const record of this.runs.records.values()) {
      if (!this.config.agents.some((agent) => agent.agentId === record.status.agentId)) this.log({ event: "run_parked", agentId: record.status.agentId, runId: record.status.runId });
    }
    for (const agent of this.config.agents) await this.recoverAgent(agent);
  }

  agent(id: string): AgentConfig {
    const agent = this.config.agents.find((candidate) => candidate.agentId === id);
    if (!agent) throw new ApiError(404, "unknown_agent", "Agent is not configured");
    return agent;
  }
  run(id: string): StoredRun {
    const record = this.runs.records.get(id);
    if (!record) throw new ApiError(404, "unknown_run", "Run does not exist");
    return record;
  }
  private active(status: RunStatus): boolean { return status.state === "starting" || status.state === "running"; }
  private activeRun(agent: AgentConfig): StoredRun | undefined { return [...this.runs.records.values()].find((record) => record.status.agentId === agent.agentId && this.active(record.status)); }

  async exclusive<T>(agent: AgentConfig, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agent.agentId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.locks.set(agent.agentId, current);
    try { return await current; } finally { if (this.locks.get(agent.agentId) === current) this.locks.delete(agent.agentId); }
  }

  async latch(agent: AgentConfig): Promise<z.infer<typeof KilledLatch> | null> {
    try { return KilledLatch.parse(JSON.parse(await readFile(agentPath(this.config, agent, "killed.json"), "utf8"))); }
    catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async requireLive(agent: AgentConfig): Promise<void> {
    if (this.closing) throw new ApiError(503, "closing", "Supervisor is stopping");
    if (this.killing.has(agent.agentId) || await this.latch(agent)) throw new ApiError(409, "killed", "Computer is killed; owner must release the latch");
  }
  private async inspect(agent: AgentConfig, name: SandboxName): Promise<ContainerInspect | null> {
    try {
      const result = await this.docker.inspectContainer(containerName(agent, name));
      if (result.Config.Labels?.["quokkabot.agent"] !== agent.agentId || result.Config.Labels["quokkabot.sandbox"] !== name) throw new Error(`Container ${containerName(agent, name)} does not belong to this agent`);
      return result;
    } catch (error) { if (dockerMissing(error)) return null; throw error; }
  }

  async status(agent: AgentConfig): Promise<ComputerStatus> {
    const latch = await this.latch(agent);
    const sandboxes: ComputerStatus["sandboxes"] = [];
    for (const name of SANDBOXES) {
      const container = await this.inspect(agent, name);
      if (!container) { sandboxes.push({ name, container: containerName(agent, name), state: "missing", runtime: this.config.runtime, startedAt: null, memoryBytes: null }); continue; }
      const state = z.enum(["created", "running", "exited", "paused", "restarting", "dead"]).parse(container.State.Status);
      const stats = container.State.Running ? await this.docker.stats(container.Id) : null;
      sandboxes.push({ name, container: containerName(agent, name), state, runtime: container.HostConfig.Runtime, startedAt: container.State.StartedAt.startsWith("0001-") ? null : container.State.StartedAt, memoryBytes: stats ? (stats.memory_stats.usage ?? null) : null });
    }
    return { agentId: agent.agentId, killed: latch !== null, killedAt: latch?.killedAt ?? null, sandboxes };
  }

  async start(agent: AgentConfig): Promise<ComputerStatus> {
    return this.exclusive(agent, async () => {
      await this.requireLive(agent);
      for (const kind of ["cli", "browser"] as const) {
        const network = agent.networks[kind];
        try {
          const existing = await this.docker.inspectNetwork(network.name);
          if (existing.Driver !== "bridge" || !existing.Internal || existing.EnableIPv6 || existing.IPAM.Config.length !== 1 || existing.IPAM.Config[0]?.Subnet !== network.subnet) throw new Error(`Existing network ${network.name} does not match the sandbox template`);
        } catch (error) { if (!dockerMissing(error)) throw error; await this.docker.createNetwork(networkBody(agent, kind)); }
      }
      for (const name of ["browser", "tools", "cli"] as const) {
        await this.requireLive(agent);
        let existing = await this.inspect(agent, name);
        // A kill disconnects endpoints. Recreate those containers after unlatch instead of reconnecting arbitrary networks.
        const endpointMissing = existing && name !== "tools" && existing.NetworkSettings.Networks[agent.networks[name].name]?.IPAddress !== agent.networks[name].address;
        if (existing && (existing.Config.Image !== this.config.images[name] || endpointMissing)) { await this.docker.removeContainer(existing.Id); existing = null; }
        if (!existing) {
          const secrets = name === "browser" ? { selkies: await this.secret(agent, "selkies_master_token"), browser: await this.secret(agent, "browser_service_token") } : undefined;
          await this.docker.createContainer(containerName(agent, name), containerBody(this.config, agent, name, secrets));
        }
        await this.requireLive(agent);
        if (!existing?.State.Running) await this.docker.startContainer(containerName(agent, name));
      }
      return this.status(agent);
    });
  }

  private async secret(agent: AgentConfig, name: string): Promise<string> {
    const value = (await readFile(join(agent.secretsDir, name), "utf8")).replace(/\r?\n$/, "");
    if (value.length < 1 || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${name} secret`);
    return value;
  }

  async stop(agent: AgentConfig): Promise<ComputerStatus> {
    return this.exclusive(agent, async () => {
      const errors: unknown[] = [];
      const signIn = this.signIns.get(agent.agentId);
      if (signIn) await this.stopSignIn(agent, signIn);
      for (const name of SANDBOXES) {
        try { await this.docker.stopContainer(containerName(agent, name)); } catch (error) { if (!dockerMissing(error) && !(error instanceof DockerError && error.statusCode === 304)) errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, "Could not stop all sandboxes");
      return this.status(agent);
    });
  }

  async wipe(agent: AgentConfig): Promise<void> {
    return this.exclusive(agent, async () => {
      await this.requireLive(agent);
      if (this.activeRun(agent) || this.terminals.has(agent.agentId) || this.cleaning.has(agent.agentId) || this.signIns.has(agent.agentId)) throw new ApiError(409, "busy", "Cannot wipe while a run, terminal, sign-in or cleanup is active");
      for (const path of [this.config.dataRoot, join(this.config.dataRoot, "agents"), agentPath(this.config, agent)]) await requireDirectory(path);
      const paths = ["cli-state", "workspace", "browser-profile", "staging", "run", "downloads"].map((name) => agentPath(this.config, agent, name));
      for (const path of paths) await requireDirectory(path);
      for (const name of SANDBOXES) {
        const container = await this.inspect(agent, name);
        if (container) await this.docker.removeContainer(container.Id);
      }
      for (const path of paths) await emptyDirectory(path);
      for (const record of [...this.runs.records.values()]) {
        if (record.status.agentId === agent.agentId) await this.runs.remove(record.status.runId);
      }
    });
  }

  async kill(agent: AgentConfig): Promise<ComputerStatus> {
    const ongoing = this.kills.get(agent.agentId);
    if (ongoing) return ongoing;
    // Set the in-memory fence synchronously, before any asynchronous filesystem work or queued lifecycle operation.
    this.killing.add(agent.agentId);
    const operation = this.performKill(agent);
    this.kills.set(agent.agentId, operation);
    try { return await operation; }
    finally { this.kills.delete(agent.agentId); this.killing.delete(agent.agentId); }
  }

  private async performKill(agent: AgentConfig): Promise<ComputerStatus> {
    try {
      const latch = await this.latch(agent) ?? { killedAt: new Date().toISOString() };
      await atomicWrite(agentPath(this.config, agent, "killed.json"), JSON.stringify(latch));
      return await this.exclusive(agent, async () => {
        const errors: unknown[] = [];
        const networks = new Map<SandboxName, Set<string>>();
        for (const name of SANDBOXES) {
          let names = new Set<string>();
          try { const existing = await this.inspect(agent, name); for (const network of Object.keys(existing?.NetworkSettings.Networks ?? {})) if (network !== "none" && network !== "host") names.add(network); }
          catch (error) { names = new Set(name === "tools" ? [] : [agent.networks[name].name]); errors.push(error); }
          networks.set(name, names);
        }
        for (const [name, names] of networks) {
          for (const network of names) {
            try { await this.docker.disconnectNetwork(network, containerName(agent, name)); }
            catch (error) { if (!dockerMissing(error)) errors.push(error); }
          }
        }
        for (const name of SANDBOXES) {
          try { await this.docker.killContainer(containerName(agent, name)); }
          catch (error) { if (!dockerMissing(error) && !(error instanceof DockerError && error.statusCode === 409)) errors.push(error); }
        }
        for (const name of SANDBOXES) {
          try { if ((await this.inspect(agent, name))?.State.Running) errors.push(new Error(`Sandbox ${name} is still running after kill`)); }
          catch (error) { errors.push(error); }
        }
        const signIn = this.signIns.get(agent.agentId);
        if (signIn) this.forgetSignIn(signIn);
        if (errors.length > 0) throw new AggregateError(errors, "Kill could not be fully verified; latch remains set");
        return this.status(agent);
      });
    } catch (error) { throw error; }
  }

  async unlatch(agent: AgentConfig): Promise<ComputerStatus> {
    return this.exclusive(agent, async () => {
      if (this.killing.has(agent.agentId)) throw new ApiError(409, "killing", "Kill is still in progress");
      await durableRemove(agentPath(this.config, agent, "killed.json"));
      return this.status(agent);
    });
  }

  // The environment of the CLI's own processes: task runs and status checks. With a shared Claude sign-in stored, the
  // CLI uses its token ahead of any sign-in in the agent's home. The container, the owner's terminal and the other
  // sandboxes never get it.
  private async claudeEnvironment(agent: AgentConfig): Promise<string[]> {
    const token = await this.claudeToken.token();
    return token === null ? cliEnvironment(agent) : [...cliEnvironment(agent), `CLAUDE_CODE_OAUTH_TOKEN=${token}`];
  }

  private execBody(cmd: string[], options: Partial<ExecCreate> = {}): ExecCreate {
    return { Cmd: cmd, User: "1000:1000", AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, ...options };
  }
  private async launch(agent: AgentConfig, sandbox: SandboxName, body: ExecCreate): Promise<{ id: string; stream: Duplex }> {
    await this.requireLive(agent);
    const { Id } = await this.docker.createExec(containerName(agent, sandbox), body);
    await this.requireLive(agent);
    return { id: Id, stream: await this.docker.startExec(Id, body.Tty) };
  }

  async startRun(agent: AgentConfig, request: StartRunRequest): Promise<RunStatus> {
    return this.exclusive(agent, async () => {
      await this.requireLive(agent);
      if (this.activeRun(agent) || this.terminals.has(agent.agentId) || this.cleaning.has(agent.agentId) || this.signIns.has(agent.agentId)) throw new ApiError(409, "busy", "An agent run, terminal, sign-in or session cleanup is already active");
      if (this.runs.records.has(request.runId)) throw new ApiError(409, "run_exists", "Run id already exists");
      const record: StoredRun = { status: { runId: request.runId, agentId: agent.agentId, state: "starting", exitCode: null, startedAt: new Date().toISOString(), endedAt: null, lines: 0, lastOutputAt: null }, execId: null, cancelRequested: false };
      try { await this.runs.reserve(record); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ApiError(409, "run_exists", "Run id already exists"); throw error; }
      let startedStream: Duplex | undefined;
      try {
        await atomicWrite(agentPath(this.config, agent, "run/mcp.json"), claudeMcpConfig(`http://${agent.controlAddress.cli}:8090/mcp`, request.mcpToken), this.own);
        const { Id } = await this.docker.createExec(containerName(agent, "cli"), this.execBody(claudeTaskArgv(request), { Env: await this.claudeEnvironment(agent), WorkingDir: CLI_PATHS.workdir }));
        record.execId = Id;
        await this.runs.save(record);
        await this.requireLive(agent);
        const stream = await this.docker.startExec(Id, false);
        startedStream = stream;
        await this.runs.updateStatus(record, { state: "running" });
        this.track(this.consumeRun(record, stream));
        stream.end(claudeUserMessage(request.prompt, request.images));
        return { ...record.status };
      } catch (error) {
        if (startedStream) {
          startedStream.destroy();
          // This branch still owns the lifecycle lock. The kill fences immediately and runs after we release it.
          this.track(this.kill(agent).then(() => undefined));
        }
        await this.runs.updateStatus(record, { state: "lost", endedAt: new Date().toISOString() });
        throw error;
      }
    });
  }

  private track(promise: Promise<void>): void {
    this.background.add(promise);
    void promise.catch(() => this.log({ event: "background_failure" })).finally(() => this.background.delete(promise));
  }

  private async consumeRun(record: StoredRun, stream: Duplex): Promise<void> {
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const pending = { stdout: "", stderr: "" };
    try {
      for await (const chunk of dockerOutput(stream)) {
        const name = chunk.stream;
        pending[name] += decoders[name].write(chunk.data);
        if (pending[name].length > 8 * 1024 * 1024) throw new Error("CLI output line exceeded 8 MiB");
        const lines = pending[name].split("\n");
        pending[name] = lines.pop()!;
        await this.runs.append(record, lines.map((line) => ({ stream: name, line: line.replace(/\r$/, "") })));
      }
      for (const name of ["stdout", "stderr"] as const) {
        pending[name] += decoders[name].end();
        if (pending[name] !== "") await this.runs.append(record, [{ stream: name, line: pending[name] }]);
      }
      await this.finishRun(record, await this.waitExec(record.execId!));
    } catch (error) {
      stream.destroy();
      if (!this.closing) {
        // Losing the recorder must not leave an unobserved model running.
        await this.kill(this.agent(record.status.agentId)).catch(() => this.log({ event: "recorder_shutdown_failed", agentId: record.status.agentId, runId: record.status.runId }));
        await this.runs.updateStatus(record, { state: "lost", endedAt: new Date().toISOString() });
        throw error;
      }
    }
  }

  async waitExec(id: string): Promise<ExecInspect> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await this.docker.inspectExec(id);
      if (!state.Running) return state;
      await delay(50);
    }
    throw new Error("Docker exec remained running after its stream closed");
  }
  private async finishRun(record: StoredRun, state: ExecInspect): Promise<void> {
    await this.runs.updateStatus(record, {
      state: state.ExitCode === null ? "lost" : record.cancelRequested ? "cancelled" : "exited",
      exitCode: state.ExitCode,
      endedAt: new Date().toISOString(),
    });
  }
  private async recoverAgent(agent: AgentConfig): Promise<void> {
    const cliRunning = (await this.inspect(agent, "cli"))?.State.Running === true;
    for (const record of this.runs.records.values()) {
      if (record.status.agentId !== agent.agentId || !this.active(record.status)) continue;
      // Docker cannot reattach exec output. Stop the whole process group before freeing the run's slot.
      if (cliRunning) {
        this.log({ event: "startup_cancel_run", agentId: agent.agentId, runId: record.status.runId });
        const result = await this.capture(agent, "cli", this.execBody([CLI_PATHS.cancelWrapper, record.status.runId]), "", 16_384);
        this.log({ event: "startup_cancel_run_finished", agentId: agent.agentId, runId: record.status.runId, exitCode: result.exitCode });
        // The wrapper returns 3 when this sandbox never started the run, including a crash before exec start.
        if (result.exitCode !== 0 && result.exitCode !== 3) throw new Error(`Startup cancellation failed for run ${record.status.runId}`);
      }
      await this.runs.updateStatus(record, { state: "lost", exitCode: null, endedAt: new Date().toISOString() });
      this.log({ event: "startup_run_lost", agentId: agent.agentId, runId: record.status.runId });
    }
    // Owner shells are not persisted in the run store and can survive a lost attach stream too.
    if (cliRunning) {
      this.log({ event: "startup_close_owner_shell", agentId: agent.agentId });
      const result = await this.capture(agent, "cli", this.execBody([CLI_PATHS.closeOwnerShell], { AttachStdin: false }), "", 16_384);
      this.log({ event: "startup_close_owner_shell_finished", agentId: agent.agentId, exitCode: result.exitCode });
      if (result.exitCode !== 0) throw new Error(`Startup owner shell closure failed for agent ${agent.agentId}`);
      const signIn = await this.capture(agent, "cli", this.execBody([CLI_PATHS.cancelSignIn], { AttachStdin: false }), "", 16_384);
      // 126/127: the running container's image predates the sign-in helper, so it cannot hold an open sign-in. The
      // container is replaced by the current image on the next computer start.
      if (signIn.exitCode === 126 || signIn.exitCode === 127) this.log({ event: "startup_sign_in_helper_missing", agentId: agent.agentId, exitCode: signIn.exitCode });
      else if (signIn.exitCode !== 0) throw new Error(`Startup sign-in cancellation failed for agent ${agent.agentId}`);
    }
  }

  async cancel(record: StoredRun): Promise<RunStatus> {
    const agent = this.agent(record.status.agentId);
    if (!this.active(record.status)) return record.status;
    // Persist the intent before dispatch; only the observed original exec exit changes the public state.
    record.cancelRequested = true;
    await this.runs.save(record);
    const result = await this.capture(agent, "cli", this.execBody([CLI_PATHS.cancelWrapper, record.status.runId]), "", 16_384);
    if (result.exitCode !== 0) throw new ApiError(502, "cancel_failed", "CLI cancellation wrapper failed");
    return { ...record.status };
  }

  async cleanup(agent: AgentConfig, runId: string, sessionId: string): Promise<void> {
    const launched = await this.exclusive(agent, async () => {
      const record = this.runs.records.get(runId);
      // Successful cleanup removes the record itself. Retrying must not touch another session's MCP file.
      if (!record) return null;
      if (record.status.agentId !== agent.agentId) throw new ApiError(404, "unknown_run", "Run does not belong to agent");
      if (this.activeRun(agent) || this.terminals.has(agent.agentId) || this.cleaning.has(agent.agentId) || this.signIns.has(agent.agentId)) throw new ApiError(409, "busy", "Cannot clean a session while a run, terminal, sign-in or cleanup is active");
      this.cleaning.add(agent.agentId);
      try { return await this.launch(agent, "cli", this.execBody([CLI_PATHS.cleanupSession, sessionId])); }
      catch (error) { this.cleaning.delete(agent.agentId); throw error; }
    });
    if (!launched) return;
    try {
      // Do not hold the lifecycle lock while waiting for a helper. Kill must be able to interrupt cleanup.
      const result = await this.collect(launched.id, launched.stream, "", 16_384);
      if (result.exitCode !== 0) throw new ApiError(502, "cleanup_failed", "CLI session cleanup failed");
      await this.exclusive(agent, async () => {
        await durableRemove(agentPath(this.config, agent, "run/mcp.json"));
        await this.runs.remove(runId);
      });
    } finally { this.cleaning.delete(agent.agentId); }
  }

  private async collect(id: string, stream: Duplex, input: string, cap: number): Promise<{ stdout: string; stderr: string; truncated: boolean; exitCode: number | null }> {
    const output = { stdout: "", stderr: "" };
    const decoder = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let truncated = false;
    stream.end(input);
    for await (const chunk of dockerOutput(stream)) {
      output[chunk.stream] += decoder[chunk.stream].write(chunk.data);
      if (output[chunk.stream].length > cap) { output[chunk.stream] = output[chunk.stream].slice(-cap); truncated = true; }
    }
    for (const name of ["stdout", "stderr"] as const) { output[name] += decoder[name].end(); if (output[name].length > cap) { output[name] = output[name].slice(-cap); truncated = true; } }
    const state = await this.waitExec(id);
    return { ...output, truncated, exitCode: state.ExitCode };
  }
  private async capture(agent: AgentConfig, sandbox: SandboxName, body: ExecCreate, input: string, cap: number) {
    const launched = await this.exclusive(agent, () => this.launch(agent, sandbox, body));
    return this.collect(launched.id, launched.stream, input, cap);
  }

  async exec(agent: AgentConfig, request: ExecRequest): Promise<ExecResult> {
    this.log({ event: "workspace_exec", agentId: agent.agentId, execId: request.execId, commandLength: request.command.length });
    const result = await this.capture(agent, "tools", this.execBody(["timeout", "--signal=KILL", `${request.timeoutS}s`, "bash", "-lc", request.command], { WorkingDir: request.cwd === "" || request.cwd === "." ? "/workspace" : `/workspace/${request.cwd}` }), "", LIMITS.execOutputChars);
    return { execId: request.execId, ...result, timedOut: result.exitCode === 137 };
  }
  async resetTools(agent: AgentConfig): Promise<void> {
    // Kills everything outside session 1 (init and its sleep): a plain `pkill -u 1000` would kill the sleep and with it
    // the container.
    const result = await this.capture(agent, "tools", this.execBody([TOOLS_PATHS.resetTools], { AttachStdin: false }), "", 16_384);
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new ApiError(502, "reset_failed", "Tools process reset failed");
  }
  async files(agent: AgentConfig, request: FilesRequest): Promise<FilesResult> {
    const result = await this.capture(agent, "tools", this.execBody([TOOLS_PATHS.filesHelper]), JSON.stringify(request), 2 * 1024 * 1024);
    if (result.truncated) throw new ApiError(502, "files_failed", "File helper exceeded the response limit");
    let parsed: FilesResult;
    try {
      parsed = FilesResult.parse(JSON.parse(result.stdout));
      if (parsed.op !== "error" && parsed.op !== request.op) throw new Error("File helper operation mismatch");
    } catch { throw new ApiError(502, "invalid_helper_output", "File helper returned invalid JSON or schema"); }
    // Typed helper errors belong to the file protocol even when the helper also signals failure through its exit.
    if (result.exitCode !== 0 && parsed.op !== "error") throw new ApiError(502, "files_failed", "File helper exited unsuccessfully");
    return parsed;
  }

  async writeWorkspaceFile(agent: AgentConfig, path: string, data: Buffer): Promise<void> {
    await this.exclusive(agent, async () => {
      await this.requireLive(agent);
      if (this.activeRun(agent)) throw new ApiError(409, "busy", "Cannot write owner images during a run");
      try { await writeWorkspaceBinary(agentPath(this.config, agent, "workspace"), path, data, this.own); }
      catch { throw new ApiError(400, "invalid_workspace_file", "Workspace file must stay inside the workspace and cannot use symlinks"); }
    });
  }

  async exportFile(agent: AgentConfig, request: FilesExportRequest): Promise<{ path: string; dispose: () => Promise<void> }> {
    // Spool on the encrypted volume before committing HTTP headers. A late helper error can still return JSON.
    const temporary = await mkdtemp(join(this.runs.root, ".export-"));
    const path = join(temporary, "file");
    const dispose = () => rm(temporary, { recursive: true, force: true });
    try {
      const launched = await this.exclusive(agent, () => this.launch(agent, "tools", this.execBody(["/opt/quokkabot/bin/qb-files", "export"])));
      const file = await open(path, "wx", 0o600);
      let bytes = 0;
      let stderr = "";
      const decoder = new StringDecoder("utf8");
      launched.stream.end(JSON.stringify(request));
      try {
        for await (const chunk of dockerOutput(launched.stream)) {
          if (chunk.stream === "stdout") {
            bytes += chunk.data.length;
            if (bytes > LIMITS.downloadMaxBytes) throw new ApiError(413, "export_too_large", "Export exceeded the file limit");
            await file.writeFile(chunk.data);
          } else if (stderr.length < 4096) stderr += decoder.write(chunk.data).slice(0, 4096 - stderr.length);
        }
      } finally { await file.close(); }
      const state = await this.waitExec(launched.id);
      if (state.ExitCode !== 0) {
        const first = stderr.split(/\r?\n/)[0] || "File export failed";
        throw new ApiError(/not[_ ]found|ENOENT/i.test(first) ? 404 : 400, "export_failed", first);
      }
      return { path, dispose };
    } catch (error) { await dispose(); throw error; }
  }

  private forgetSignIn(record: SignIn): void {
    clearTimeout(record.timer);
    record.stream.destroy();
    if (this.signIns.get(record.agentId) === record) this.signIns.delete(record.agentId);
  }

  private async stopSignIn(agent: AgentConfig, record: SignIn): Promise<void> {
    const launched = await this.launch(agent, "cli", this.execBody([CLI_PATHS.cancelSignIn], { AttachStdin: false }));
    const result = await this.collect(launched.id, launched.stream, "", 16_384);
    if (result.exitCode !== 0) throw new ApiError(502, "sign_in_cancel_failed", "Could not stop Claude sign-in");
    // A missing wrapper record is not proof that a just-started Docker exec has stopped.
    await this.waitExec(record.execId);
    this.forgetSignIn(record);
  }

  // `claude setup-token` runs in the agent's CLI sandbox, which already reaches Claude. Its terminal UI needs a TTY; a
  // wide one keeps the URL and the token on single lines.
  async startSignIn(agent: AgentConfig): Promise<{ signInId: string; url: string }> {
    const record = await this.exclusive(agent, async () => {
      await this.requireLive(agent);
      if (this.activeRun(agent) || this.terminals.has(agent.agentId) || this.cleaning.has(agent.agentId)) throw new ApiError(409, "busy", "An agent run, terminal or session cleanup is already active");
      const previous = this.signIns.get(agent.agentId);
      if (previous) await this.stopSignIn(agent, previous);
      const id = randomUUID();
      const { Id } = await this.docker.createExec(containerName(agent, "cli"), this.execBody([CLI_PATHS.signInWrapper, id], { Tty: true, ConsoleSize: [50, 1000], Env: [...cliEnvironment(agent), "TERM=xterm-256color"], WorkingDir: CLI_PATHS.workdir }));
      await this.requireLive(agent);
      let stream: Duplex;
      try { stream = await this.docker.startExec(Id, true); }
      catch (error) {
        // A failed attach can still have started the login. Fence immediately before releasing the lifecycle lock.
        this.track(this.kill(agent).then(() => undefined));
        throw error;
      }
      const session = readSignIn(id, agent.agentId, Id, stream, async () => (await this.waitExec(Id)).ExitCode,
        (signInId) => this.track(this.cancelSignIn(signInId).catch(() => this.kill(agent).then(() => undefined))));
      this.signIns.set(agent.agentId, session);
      return session;
    });
    try { return { signInId: record.id, url: await within(record.url, 30_000, "Claude did not return a sign-in URL within 30 seconds") }; }
    catch (error) { await this.cancelSignIn(record.id); throw error; }
  }

  private signIn(id: string): SignIn {
    const record = [...this.signIns.values()].find((candidate) => candidate.id === id);
    if (!record) throw new ApiError(404, "unknown_sign_in", "Sign-in expired or ended. Start again.");
    return record;
  }

  async cancelSignIn(id: string): Promise<void> {
    const record = [...this.signIns.values()].find((candidate) => candidate.id === id);
    if (!record) return;
    const agent = this.agent(record.agentId);
    await this.exclusive(agent, async () => {
      if (this.signIns.get(agent.agentId) === record) await this.stopSignIn(agent, record);
    });
  }

  async signInStatus(agent: AgentConfig): Promise<ClaudeSignInStatus> {
    const launched = await this.exclusive(agent, async () => {
      await this.requireLive(agent);
      if (this.activeRun(agent) || this.terminals.has(agent.agentId) || this.cleaning.has(agent.agentId) || this.signIns.has(agent.agentId)) throw new ApiError(409, "busy", "The agent's computer is busy");
      this.cleaning.add(agent.agentId);
      try {
        return await this.launch(agent, "cli", this.execBody(["timeout", "--signal=KILL", "15s", CLI_PATHS.claude, "auth", "status", "--json"], { Env: await this.claudeEnvironment(agent), WorkingDir: CLI_PATHS.workdir }));
      } catch (error) { this.cleaning.delete(agent.agentId); throw error; }
    });
    try {
      const result = await this.collect(launched.id, launched.stream, "", 16_384);
      if (result.truncated) throw new Error("Status exceeded the output limit");
      const status = ClaudeSignInStatus.parse(JSON.parse(result.stdout));
      if (result.exitCode !== 0 && status.loggedIn) throw new Error("Status failed");
      return status;
    } catch { throw new ApiError(502, "sign_in_status_failed", "Could not check Claude sign-in status"); }
    finally { this.cleaning.delete(agent.agentId); }
  }

  // The code goes in as a paste, then Enter as its own key press. On success the CLI prints the token; it goes straight
  // to the token store, the CLI is stopped, and every agent's next run uses the token.
  async submitSignIn(id: string, code: string): Promise<ClaudeSignInView> {
    const record = this.signIn(id);
    const agent = this.agent(record.agentId);
    await this.exclusive(agent, async () => {
      if (this.signIns.get(agent.agentId) !== record || record.submitting) throw new ApiError(409, "sign_in_busy", "Sign-in is already being finished or has ended");
      await this.requireLive(agent);
      record.submitting = true;
      record.stream.write(code);
    });
    try {
      const finished = within(record.token, 60_000, "Claude sign-in did not finish within 60 seconds");
      void finished.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      record.stream.write("\r");
      let token: string;
      try { token = await finished; }
      catch (error) { throw error instanceof ApiError ? new ApiError(error.status, error.code, claudeSignInError(error.message, code)) : error; }
      const view = await this.claudeToken.save(record.id, token);
      await this.cancelSignIn(id);
      return view;
    } catch (error) { await this.cancelSignIn(id); throw error; }
  }

  claudeSignIn(): Promise<ClaudeSignInView> { return this.claudeToken.view(); }

  async signOutClaude(id?: string): Promise<{ removed: boolean }> {
    const removed = await this.claudeToken.remove(id);
    if (removed) this.log({ event: "claude_token_removed", matched: id !== undefined });
    return { removed };
  }

  terminalsBusy(agent: AgentConfig): boolean {
    return this.terminals.has(agent.agentId);
  }

  async openTerminal(agent: AgentConfig): Promise<Terminal> {
    return this.exclusive(agent, async () => {
      await this.requireLive(agent);
      if (this.terminals.has(agent.agentId) || this.activeRun(agent) || this.cleaning.has(agent.agentId) || this.signIns.has(agent.agentId)) throw new ApiError(409, "busy", "An agent run, terminal, sign-in or session cleanup is already active");
      this.terminals.add(agent.agentId);
      try {
        const launched = await this.launch(agent, "cli", this.execBody([CLI_PATHS.ownerShell], { Tty: true, Env: [...cliEnvironment(agent), "TERM=xterm-256color"], WorkingDir: CLI_PATHS.workdir }));
        // Closing the stream does not hang up the shell on a real Engine. The slot stays taken until the shell's whole
        // session is gone, so no run starts beside a leftover owner shell.
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          void this.capture(agent, "cli", this.execBody([CLI_PATHS.closeOwnerShell], { AttachStdin: false }), "", 16_384)
            .catch((error: unknown) => this.log({ event: "owner_shell_close_failed", agentId: agent.agentId, error: String(error) }))
            .finally(() => this.terminals.delete(agent.agentId));
        };
        return { execId: launched.id, stream: launched.stream, release };
      } catch (error) { this.terminals.delete(agent.agentId); throw error; }
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.signIns.values()].map((record) => this.cancelSignIn(record.id)));
    this.closing = true;
    this.docker.close();
    await Promise.allSettled(this.background);
  }
}
