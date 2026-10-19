import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_PATHS, RunStatus, StartRunRequest } from "@quokkabot/shared";
import { SupervisorConfig } from "../src/config.js";
import { Supervisor } from "../src/supervisor.js";
import { signInUrl } from "../src/sign-in.js";
import { cliEnvironment } from "../src/templates.js";
import type { ExecCreate } from "../src/docker.js";
import { multiplex } from "./fake-docker.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const request = StartRunRequest.parse({ runId, sessionId: runId, resume: false, model: "claude-opus-4-6", effort: "high", mcpToken: "a".repeat(32), prompt: "Hello" });
const url = "https://claude.com/cai/oauth/authorize?code=true&state=abcdefgh";
const code = "abcdefgh_1234#state_abcdefgh";
interface Exec {
  body: ExecCreate; stream: Duplex; input: string; running: boolean; exitCode: number | null;
}

// A Docker attach stream with independent stdin and multiplexed stdout, without a listening socket.
class MemoryDocker {
  execs: Exec[] = [];
  loginOutput = `Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\nPaste code here if prompted > `;
  loginResult = "Some success wording\n";
  loginExit = 0;
  loginHold = false;
  status = { loggedIn: true, email: "owner@example.test", subscriptionType: "max", privateField: "discard" };
  create = async (_container: string, body: ExecCreate) => {
    const exec: Exec = { body, stream: undefined as unknown as Duplex, input: "", running: true, exitCode: null };
    exec.stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) { exec.input += chunk.toString(); callback(); },
      final: (callback) => {
        const cmd = body.Cmd[0];
        if (cmd === CLI_PATHS.signInWrapper) {
          if (!this.loginHold) { exec.stream.push(multiplex(1, this.loginResult)); this.finish(exec, this.loginExit); }
        } else if (cmd === CLI_PATHS.cancelSignIn) {
          for (const candidate of this.execs) if (candidate.body.Cmd[0] === CLI_PATHS.signInWrapper && candidate.running) this.finish(candidate, 137);
          this.finish(exec, 0);
        } else if (body.Cmd.includes("status")) {
          exec.stream.push(multiplex(1, JSON.stringify(this.status)));
          this.finish(exec, 0);
        } else if (cmd !== CLI_PATHS.ownerShell && cmd !== CLI_PATHS.runWrapper && cmd !== CLI_PATHS.cleanupSession) this.finish(exec, 0);
        callback();
      },
    });
    this.execs.push(exec);
    return { Id: String(this.execs.length - 1) };
  };
  start = async (id: string) => {
    const exec = this.execs[Number(id)]!;
    if (exec.body.Cmd[0] === CLI_PATHS.signInWrapper) {
      // Split both a Docker frame and the URL, to exercise streaming rather than a single output event.
      const output = multiplex(1, this.loginOutput);
      exec.stream.push(output.subarray(0, 13));
      exec.stream.push(output.subarray(13));
    }
    return exec.stream;
  };
  inspect = async (id: string) => {
    const exec = this.execs[Number(id)]!;
    return { Running: exec.running, ExitCode: exec.exitCode };
  };
  finish(exec: Exec, exitCode: number) { exec.running = false; exec.exitCode = exitCode; exec.stream.push(null); }
}

describe("Claude sign-in with Docker exec streams", () => {
  let root: string;
  let supervisor: Supervisor;
  let docker: MemoryDocker;
  let agent: SupervisorConfig["agents"][number];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qb-sign-in-"));
    const config = SupervisorConfig.parse({
      socketPath: join(root, "api.sock"), dockerSocket: join(root, "docker.sock"), tokenFile: join(root, "token"), dataRoot: root, dataMarker: ".quokkabot-volume", runtime: "runsc", viewOrigin: "https://view.example.test",
      images: Object.fromEntries(["cli", "tools", "browser"].map(name => [name, `quokkabot/${name}@sha256:${"a".repeat(64)}`])),
      agents: [{ agentId, index: 1, networks: { cli: { name: "qb-cli-1", subnet: "10.231.1.0/24", address: "10.231.1.10" }, browser: { name: "qb-browser-1", subnet: "10.232.1.0/24", address: "10.232.1.10" } }, egressProxy: { cli: "http://10.231.1.2:3128", browser: "http://10.232.1.2:3128" }, controlAddress: { cli: "10.231.1.3" }, secretsDir: root }],
      limits: { cli: { memoryMb: 1536, cpus: 1, pids: 512 }, tools: { memoryMb: 1536, cpus: 1, pids: 512 }, browser: { memoryMb: 3072, cpus: 2, pids: 2048, shmMb: 1024 } },
    });
    await mkdir(join(root, "agents/1/run"), { recursive: true });
    await mkdir(join(root, "runs"));
    supervisor = new Supervisor(config, { own: async () => undefined, log: vi.fn() });
    agent = config.agents[0]!;
    docker = new MemoryDocker();
    vi.spyOn(supervisor.docker, "createExec").mockImplementation(docker.create);
    vi.spyOn(supervisor.docker, "startExec").mockImplementation(docker.start);
    vi.spyOn(supervisor.docker, "inspectExec").mockImplementation(docker.inspect);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await supervisor.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("accepts only provider HTTPS authorize URLs", () => {
    expect(signInUrl(`visit: ${url}`)).toBe(url);
    expect(signInUrl("https://claude.ai/oauth/authorize?state=ok")).toBe("https://claude.ai/oauth/authorize?state=ok");
    for (const value of ["https://evil.test/oauth/authorize", "https://claude.com.evil.test/oauth/authorize", "https://claude.com/other", "http://claude.com/oauth/authorize", "https://evil@claude.com/oauth/authorize", "https://claude.com:444/oauth/authorize"]) expect(signInUrl(value)).toBeNull();
  });

  it("returns the URL and submits stdin, then reads only the public status fields", async () => {
    const started = await supervisor.startSignIn(agent);
    expect(started).toEqual({ signInId: expect.any(String), url });
    const exec = docker.execs[0]!;
    expect(exec.body).toMatchObject({ Cmd: [CLI_PATHS.signInWrapper, started.signInId], Tty: false, AttachStdin: true, User: "1000:1000", Env: cliEnvironment(agent), WorkingDir: CLI_PATHS.workdir });
    expect(await supervisor.submitSignIn(started.signInId, code)).toEqual({ loggedIn: true, email: "owner@example.test", subscriptionType: "max" });
    expect(exec.input).toBe(code + "\n");
    expect(supervisor.runs.records.size).toBe(0);
    expect(supervisor.log).not.toHaveBeenCalled();
  });

  it("returns the trimmed bounded CLI failure without control characters or echoed codes", async () => {
    docker.loginExit = 1;
    docker.loginResult = `Login failed: Request failed with status code 400\u0007 ${code}\n`;
    const started = await supervisor.startSignIn(agent);
    await expect(supervisor.submitSignIn(started.signInId, code)).rejects.toMatchObject({ status: 400, message: "Login failed: Request failed with status code 400 [redacted]" });
    const next = await supervisor.startSignIn(agent);
    await supervisor.cancelSignIn(next.signInId);
  });

  it.each(["https://evil.test/oauth/authorize\n", "No URL yet\n"])("times out and kills when no allowed URL appears: %s", async (output) => {
    docker.loginOutput = output;
    vi.useFakeTimers();
    const started = supervisor.startSignIn(agent);
    const rejected = expect(started).rejects.toMatchObject({ code: "sign_in_timeout" });
    await expect(supervisor.openTerminal(agent)).rejects.toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(docker.execs[0]!.running).toBe(false);
  });

  it("refuses runs, terminals, cleanup and status while a sign-in is open, and replaces the old sign-in", async () => {
    const first = await supervisor.startSignIn(agent);
    await expect(supervisor.startRun(agent, request)).rejects.toMatchObject({ status: 409 });
    await expect(supervisor.openTerminal(agent)).rejects.toMatchObject({ status: 409 });
    await expect(supervisor.signInStatus(agent)).rejects.toMatchObject({ status: 409 });
    // Cleanup checks a stored run before touching the session.
    supervisor.runs.records.set(runId, { status: RunStatus.parse({ runId, agentId, state: "exited", exitCode: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), lines: 0, lastOutputAt: null }), execId: null, cancelRequested: false });
    await expect(supervisor.cleanup(agent, runId, runId)).rejects.toMatchObject({ status: 409 });
    const second = await supervisor.startSignIn(agent);
    expect(second.signInId).not.toBe(first.signInId);
    expect(docker.execs[0]!.running).toBe(false);
    await expect(supervisor.submitSignIn(first.signInId, code)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses sign-in beside a run or terminal and frees the slot after cancellation", async () => {
    await supervisor.startRun(agent, request);
    await expect(supervisor.startSignIn(agent)).rejects.toMatchObject({ status: 409 });
    const run = supervisor.runs.records.get(runId)!;
    run.status.state = "exited";
    docker.finish(docker.execs[0]!, 0);
    const terminal = await supervisor.openTerminal(agent);
    await expect(supervisor.startSignIn(agent)).rejects.toMatchObject({ status: 409 });
    terminal.stream.destroy(); terminal.release();
    await vi.waitFor(() => expect(supervisor.terminalsBusy(agent)).toBe(false));
    const started = await supervisor.startSignIn(agent);
    await supervisor.cancelSignIn(started.signInId);
    await supervisor.cancelSignIn(started.signInId);
    expect(docker.execs.find(exec => exec.body.Cmd[0] === CLI_PATHS.signInWrapper)?.running).toBe(false);
    expect(await supervisor.signInStatus(agent)).toMatchObject({ loggedIn: true });
  });

  it("refuses sign-in while cleanup is active, then permits an idle signed-out status check", async () => {
    supervisor.runs.records.set(runId, { status: RunStatus.parse({ runId, agentId, state: "exited", exitCode: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), lines: 0, lastOutputAt: null }), execId: null, cancelRequested: false });
    const cleanup = supervisor.cleanup(agent, runId, runId);
    await vi.waitFor(() => expect(docker.execs[0]?.body.Cmd[0]).toBe(CLI_PATHS.cleanupSession));
    await expect(supervisor.startSignIn(agent)).rejects.toMatchObject({ status: 409 });
    await expect(supervisor.signInStatus(agent)).rejects.toMatchObject({ status: 409 });
    docker.finish(docker.execs[0]!, 0);
    await cleanup;
    docker.status = { loggedIn: false, email: "", subscriptionType: "", privateField: "discard" };
    expect(await supervisor.signInStatus(agent)).toEqual({ loggedIn: false, email: "", subscriptionType: "" });
  });

  it("fences the computer if attaching a login fails after dispatch", async () => {
    vi.spyOn(supervisor.docker, "startExec").mockRejectedValueOnce(new Error("Attach lost"));
    const kill = vi.spyOn(supervisor, "kill");
    await expect(supervisor.startSignIn(agent)).rejects.toThrow("Attach lost");
    expect(kill).toHaveBeenCalledWith(agent);
    await expect(supervisor.openTerminal(agent)).rejects.toMatchObject({ status: 409 });
  });

  it("does not release the sign-in slot when cancellation fails", async () => {
    const started = await supervisor.startSignIn(agent);
    const create = vi.spyOn(supervisor.docker, "createExec");
    create.mockRejectedValueOnce(new Error("Docker unavailable"));
    await expect(supervisor.cancelSignIn(started.signInId)).rejects.toThrow("Docker unavailable");
    await expect(supervisor.openTerminal(agent)).rejects.toMatchObject({ status: 409 });
    await supervisor.cancelSignIn(started.signInId);
    expect(await supervisor.signInStatus(agent)).toMatchObject({ loggedIn: true });
  });

  it("expires at ten minutes and kills the login process group", async () => {
    vi.useFakeTimers();
    const started = await supervisor.startSignIn(agent);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(docker.execs[0]!.running).toBe(false));
    await expect(supervisor.submitSignIn(started.signInId, code)).rejects.toMatchObject({ status: 404 });
    expect(docker.execs.some(exec => exec.body.Cmd[0] === CLI_PATHS.cancelSignIn)).toBe(true);
  });

  it("kills a login that does not exit within sixty seconds after the code", async () => {
    docker.loginHold = true;
    vi.useFakeTimers();
    const started = await supervisor.startSignIn(agent);
    const result = supervisor.submitSignIn(started.signInId, code);
    const rejected = expect(result).rejects.toMatchObject({ code: "sign_in_timeout" });
    await expect(supervisor.openTerminal(agent)).rejects.toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(docker.execs[0]!.running).toBe(false);
  });
});
