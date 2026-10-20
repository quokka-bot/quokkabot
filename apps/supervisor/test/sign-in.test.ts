import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_PATHS, RunStatus, StartRunRequest } from "@quokkabot/shared";
import { SupervisorConfig } from "../src/config.js";
import { Supervisor } from "../src/supervisor.js";
import { screenText, signInToken, signInUrl } from "../src/sign-in.js";
import { cliEnvironment, containerBody } from "../src/templates.js";
import type { ExecCreate } from "../src/docker.js";
import { multiplex } from "./fake-docker.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const request = StartRunRequest.parse({ runId, sessionId: runId, resume: false, model: "claude-opus-4-6", effort: "high", mcpToken: "a".repeat(32), prompt: "Hello" });
const url = "https://claude.com/cai/oauth/authorize?code=true&state=abcdefgh";
const code = "abcdefgh_1234#state_abcdefgh";
const token = `sk-ant-oat01-${"Tok3n_-".repeat(13)}AA`;
// What `claude setup-token` draws in a TTY: spaces as cursor moves, the URL as an OSC 8 hyperlink around its text.
const link = (target: string) => `\x1b]8;id=k19f2c;${target}\x07${target}\x1b]8;;\x07`;
const urlScreen = (target: string) => `\x1b[?25l\x1b[2mBrowser\x1b[1Cdidn't\x1b[1Copen?\x1b[22m\r\n${link(target)}\r\nPaste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>\x1b[1C`;
const successScreen = (value: string) => `\x1b[32m✓\x1b[1CLong-lived\x1b[1Cauthentication\x1b[1Ctoken\x1b[1Ccreated\x1b[1Csuccessfully!\x1b[39m\r\n\r\nYour\x1b[1COAuth\x1b[1Ctoken\x1b[1C(valid\x1b[1Cfor\x1b[1C1\x1b[1Cyear):\r\n\r\n\x1b[33m${value}\x1b[39m\r\n\r\n\x1b[2mStore\x1b[1Cthis\x1b[1Ctoken\x1b[1Csecurely.\x1b[22m\r\n`;
interface Exec {
  body: ExecCreate; stream: Duplex; input: string; running: boolean; exitCode: number | null;
}

// A Docker attach stream with independent stdin and multiplexed stdout, without a listening socket.
// A TTY exec (the sign-in) has raw output and gets its input key by key; every other exec is multiplexed.
class MemoryDocker {
  execs: Exec[] = [];
  loginOutput = urlScreen(url);
  loginResult = successScreen(token);
  // null: the CLI shows the result and waits, as it does after an error.
  loginExit: number | null = 0;
  loginHold = false;
  status = { loggedIn: true, email: "owner@example.test", subscriptionType: "max", privateField: "discard" };
  create = async (_container: string, body: ExecCreate) => {
    const exec: Exec = { body, stream: undefined as unknown as Duplex, input: "", running: true, exitCode: null };
    exec.stream = new Duplex({
      read() {},
      write: (chunk: Buffer, _encoding, callback) => {
        exec.input += chunk.toString();
        if (body.Cmd[0] === CLI_PATHS.signInWrapper && exec.input.endsWith("\r") && !this.loginHold) {
          exec.stream.push(Buffer.from(this.loginResult));
          if (this.loginExit !== null) this.finish(exec, this.loginExit);
        }
        callback();
      },
      final: (callback) => {
        const cmd = body.Cmd[0];
        if (cmd === CLI_PATHS.signInWrapper) {
          // Ending a TTY's input is not how the sign-in is driven.
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
      // Split the escape sequence and the URL, to exercise streaming rather than a single output event.
      const output = Buffer.from(this.loginOutput);
      const at = this.loginOutput.indexOf("https://") - 3;
      exec.stream.push(output.subarray(0, at));
      exec.stream.push(output.subarray(at, at + 20));
      exec.stream.push(output.subarray(at + 20));
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
    await mkdir(join(root, "claude-sign-in"), { mode: 0o700 });
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

  it("accepts only provider HTTPS authorize URLs, and only from a complete hyperlink", () => {
    expect(signInUrl(urlScreen(url))).toBe(url);
    expect(signInUrl(link("https://claude.ai/oauth/authorize?state=ok"))).toBe("https://claude.ai/oauth/authorize?state=ok");
    for (const value of ["https://evil.test/oauth/authorize", "https://claude.com.evil.test/oauth/authorize", "https://claude.com/other", "http://claude.com/oauth/authorize", "https://evil@claude.com/oauth/authorize", "https://claude.com:444/oauth/authorize"]) expect(signInUrl(link(value))).toBeNull();
    // Visible text can be cut by the terminal's width; an unterminated hyperlink can be cut by the stream.
    expect(signInUrl(`visit: ${url}\r\n`)).toBeNull();
    expect(signInUrl(`\x1b]8;id=a;${url}`)).toBeNull();
  });

  it("reads the token only after success, and only when every copy on the screen agrees", () => {
    expect(signInToken(screenText(successScreen(token)))).toBe(token);
    expect(signInToken(screenText(successScreen(token) + successScreen(token)))).toBe(token);
    expect(signInToken(screenText(`${token}\r\n`))).toBeNull();
    // A token cut by a narrow terminal leaves two different strings.
    expect(signInToken(screenText(successScreen(token) + successScreen(token.slice(0, 60))))).toBeNull();
    expect(signInToken(screenText(successScreen("sk-ant-oat01-short")))).toBeNull();
    // A chunk can end inside the token: nothing counts until a character after it arrives.
    const screen = successScreen(token);
    expect(signInToken(screenText(screen.slice(0, screen.indexOf(token) + token.length)))).toBeNull();
    expect(signInToken(screenText(screen.slice(0, screen.indexOf(token) + token.length + 1)))).toBe(token);
    expect(screenText("Paste\x1b[1Ccode\x1b[3Chere")).toBe("Paste code   here");
  });

  it("runs setup-token in a wide TTY, types the code then Enter, and stores the token for every agent", async () => {
    const started = await supervisor.startSignIn(agent);
    expect(started).toEqual({ signInId: expect.any(String), url });
    const exec = docker.execs[0]!;
    expect(exec.body).toMatchObject({ Cmd: [CLI_PATHS.signInWrapper, started.signInId], Tty: true, ConsoleSize: [50, 1000], AttachStdin: true, User: "1000:1000", Env: [...cliEnvironment(agent), "TERM=xterm-256color"], WorkingDir: CLI_PATHS.workdir });
    const view = await supervisor.submitSignIn(started.signInId, code);
    expect(view).toEqual({ signedIn: true, signedInAt: expect.any(String) });
    expect(exec.input).toBe(code + "\r");
    expect(await supervisor.claudeToken.token()).toBe(token);
    expect(await supervisor.claudeSignIn()).toEqual(view);
    const file = join(root, "claude-sign-in/token.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ id: started.signInId, token, signedInAt: view.signedInAt });
    expect(supervisor.runs.records.size).toBe(0);
    expect(supervisor.log).not.toHaveBeenCalled();
  });

  it("returns the trimmed bounded CLI error without control characters or echoed codes, and stops the waiting CLI", async () => {
    docker.loginExit = null;
    docker.loginResult = `\x1b[31mOAuth\x1b[1Cerror:\x1b[1CRequest\x1b[1Cfailed\x1b[1Cwith\x1b[1Cstatus\x1b[1Ccode\x1b[1C400\u0007 ${code}\x1b[1CPress\x1b[1CEnter\x1b[1Cto\x1b[1Cretry.\x1b[39m\r\n`;
    const started = await supervisor.startSignIn(agent);
    await expect(supervisor.submitSignIn(started.signInId, code)).rejects.toMatchObject({ status: 400, message: "OAuth error: Request failed with status code 400 [redacted]" });
    expect(docker.execs[0]!.running).toBe(false);
    expect(await supervisor.claudeToken.token()).toBeNull();
    const next = await supervisor.startSignIn(agent);
    await supervisor.cancelSignIn(next.signInId);
  });

  it("stores the token as soon as the CLI shows it, and stops a CLI that does not exit", async () => {
    docker.loginExit = null;
    const started = await supervisor.startSignIn(agent);
    expect(await supervisor.submitSignIn(started.signInId, code)).toMatchObject({ signedIn: true });
    expect(await supervisor.claudeToken.token()).toBe(token);
    expect(docker.execs[0]!.running).toBe(false);
    expect(docker.execs.some(exec => exec.body.Cmd[0] === CLI_PATHS.cancelSignIn)).toBe(true);
  });

  it("refuses an exit without a complete token", async () => {
    docker.loginResult = successScreen("sk-ant-oat01-short");
    const started = await supervisor.startSignIn(agent);
    await expect(supervisor.submitSignIn(started.signInId, code)).rejects.toMatchObject({ status: 400, message: "Claude sign-in failed. Start again." });
    expect(await supervisor.claudeToken.token()).toBeNull();
  });

  it.each([link("https://evil.test/oauth/authorize") + "\r\n", `visit: ${url}\r\n`, "No URL yet\r\n"])("times out and kills when no allowed URL appears: %s", async (output) => {
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
  it("gives the stored token to task runs and status checks only, never to the container, the owner's terminal or the tools sandbox", async () => {
    const tokenEnv = `CLAUDE_CODE_OAUTH_TOKEN=${token}`;
    const started = await supervisor.startSignIn(agent);
    await supervisor.submitSignIn(started.signInId, code);
    expect(docker.execs[0]!.body.Env).not.toContain(tokenEnv);
    await supervisor.startRun(agent, request);
    const run = docker.execs.find(exec => exec.body.Cmd[0] === CLI_PATHS.runWrapper)!;
    expect(run.body.Env).toEqual([...cliEnvironment(agent), tokenEnv]);
    supervisor.runs.records.get(runId)!.status.state = "exited";
    docker.finish(run, 0);
    expect(await supervisor.signInStatus(agent)).toMatchObject({ loggedIn: true });
    expect(docker.execs.find(exec => exec.body.Cmd.includes("status"))!.body.Env).toContain(tokenEnv);
    const terminal = await supervisor.openTerminal(agent);
    expect(docker.execs.find(exec => exec.body.Cmd[0] === CLI_PATHS.ownerShell)!.body.Env!.join("\n")).not.toContain(token);
    terminal.stream.destroy(); terminal.release();
    await vi.waitFor(() => expect(supervisor.terminalsBusy(agent)).toBe(false));
    vi.spyOn(supervisor.docker, "createExec").mockImplementationOnce(async (_container, body) => { expect(JSON.stringify(body)).not.toContain(token); return docker.create(_container, body); });
    await supervisor.exec(agent, { execId: runId, command: "env", cwd: "", timeoutS: 5 });
    for (const sandbox of ["cli", "tools", "browser"] as const) {
      expect(JSON.stringify(containerBody(supervisor.config, agent, sandbox, { selkies: "s", browser: "b" }))).not.toContain(token);
    }
    expect(JSON.stringify(vi.mocked(supervisor.log).mock.calls)).not.toContain(token);
  });

  it("runs without the token once the owner signs out, and an older sign-in's expiry leaves a newer token", async () => {
    const first = await supervisor.startSignIn(agent);
    await supervisor.submitSignIn(first.signInId, code);
    const second = await supervisor.startSignIn(agent);
    await supervisor.submitSignIn(second.signInId, code);
    expect(await supervisor.signOutClaude(first.signInId)).toEqual({ removed: false });
    expect(await supervisor.claudeToken.token()).toBe(token);
    expect(await supervisor.signOutClaude(second.signInId)).toEqual({ removed: true });
    expect(await supervisor.claudeSignIn()).toEqual({ signedIn: false, signedInAt: null });
    const third = await supervisor.startSignIn(agent);
    await supervisor.submitSignIn(third.signInId, code);
    expect(await supervisor.signOutClaude()).toEqual({ removed: true });
    await supervisor.startRun(agent, request);
    const run = docker.execs.find(exec => exec.body.Cmd[0] === CLI_PATHS.runWrapper)!;
    expect(run.body.Env).toEqual(cliEnvironment(agent));
    docker.finish(run, 0);
  });

  it("refuses to run with an unreadable stored sign-in and never quotes it", async () => {
    await writeFile(join(root, "claude-sign-in/token.json"), `{"token":"${token}"`);
    await expect(supervisor.startRun(agent, request)).rejects.toThrow("The stored Claude sign-in is unreadable");
    expect(await supervisor.signOutClaude()).toEqual({ removed: true });
  });
});
