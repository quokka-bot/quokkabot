// Smoke test of src/docker.ts against a real Docker Engine. Every Engine call goes through the supervisor's own
// client; nothing else talks to Docker. It creates one throwaway alpine container (runc, `sleep infinity`, name
// prefix qb-smoke-), runs exec checks in it and removes it. Like the cli and tools images, the container runs
// tini as PID 1 (Docker's init) with `sleep infinity` as its child, as user 1000:1000.
//
// "client" checks prove src/docker.ts. "supervisor assumption" checks test what supervisor.ts and server.ts
// expect from the Engine for the terminal and the tools reset; a failure there is a supervisor design bug.
//
// Run from apps/supervisor (Node 26 strips the types; the flag keeps older Node 24 releases working):
//   node --experimental-strip-types scripts/real-docker-smoke.ts <docker socket path> [image]
// The socket path can also come from DOCKER_HOST=unix://<path>. Find it with `docker context inspect`.
// The image must already be present locally (default alpine:3; `docker pull alpine:3`). The supervisor never pulls.
import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Docker, DockerError, dockerMissing, dockerOutput } from "../src/docker.ts";
import type { ContainerInspect, ExecCreate, ExecInspect } from "../src/docker.ts";

function socketPath(): string {
  const argument = process.argv[2];
  if (argument !== undefined && argument !== "") return argument;
  const host = process.env.DOCKER_HOST;
  if (host !== undefined && host.startsWith("unix://")) return host.slice("unix://".length);
  throw new Error("Pass the Docker socket path as the first argument or set DOCKER_HOST=unix://<path> (see `docker context inspect`)");
}

const docker = new Docker(socketPath());
const image = process.argv[3] ?? "alpine:3";
const container = `qb-smoke-${randomBytes(4).toString("hex")}`;
type Group = "client" | "supervisor assumption";
const failures: Record<Group, string[]> = { client: [], "supervisor assumption": [] };
const passed: Record<Group, number> = { client: 0, "supervisor assumption": 0 };
let group: Group = "client";

function check(name: string, condition: boolean, detail: string): void {
  if (!condition) throw new Error(`${name}: ${detail}`);
  passed[group]++;
  process.stdout.write(`ok   [${group}] ${name}: ${detail}\n`);
}

async function step(name: string, action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) {
    failures[group].push(name);
    process.stdout.write(`FAIL [${group}] ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function execBody(cmd: string[], options: Partial<ExecCreate> = {}): ExecCreate {
  // Same shape and user as the supervisor's exec bodies.
  return { Cmd: cmd, User: "1000:1000", AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, ...options };
}

async function waitExit(id: string): Promise<ExecInspect> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await docker.inspectExec(id);
    if (!state.Running) return state;
    await delay(25);
  }
  throw new Error(`exec ${id} still running 5 s after its stream closed`);
}

interface ExecOutcome { stdout: Buffer; stderr: Buffer; exit: ExecInspect; chunks: number; ms: number }
async function execOnce(body: ExecCreate, input: Buffer): Promise<ExecOutcome> {
  const started = performance.now();
  const { Id } = await docker.createExec(container, body);
  const stream = await docker.startExec(Id, body.Tty);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let chunks = 0;
  // end() writes stdin and half-closes the hijacked connection, which Docker turns into EOF on the process's stdin.
  stream.end(input);
  for await (const chunk of dockerOutput(stream, body.Tty)) {
    chunks++;
    (chunk.stream === "stdout" ? stdout : stderr).push(chunk.data);
  }
  const exit = await waitExit(Id);
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exit, chunks, ms: Math.round(performance.now() - started) };
}

// Accumulates a TTY stream as text and lets the caller wait for a pattern.
class TtyReader {
  text = "";
  ended = false;
  // Destroying the stream on purpose ends the iteration with ERR_STREAM_PREMATURE_CLOSE; end() rethrows it.
  error: unknown = null;
  private readonly done: Promise<void>;
  constructor(stream: Duplex) {
    this.done = (async () => {
      for await (const chunk of dockerOutput(stream, true)) this.text += chunk.data.toString("utf8");
    })().catch((error: unknown) => { this.error = error; }).finally(() => { this.ended = true; });
  }
  async waitFor(pattern: RegExp, what: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (pattern.test(this.text)) return;
      if (this.ended) break;
      await delay(25);
    }
    throw new Error(`TTY output never showed ${what}; got ${JSON.stringify(this.text.slice(-300))}`);
  }
  async end(): Promise<void> { await this.done; if (this.error !== null) throw this.error; }
}

function seq(count: number): string {
  const lines: string[] = [];
  for (let value = 1; value <= count; value++) lines.push(String(value));
  return lines.join("\n") + "\n";
}

function firstDifference(left: Buffer, right: Buffer): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) if (left[index] !== right[index]) return index;
  return left.length === right.length ? -1 : length;
}

async function main(): Promise<void> {
  process.stdout.write(`Docker smoke: container ${container}, image ${image}\n`);
  try {
    await docker.createContainer(container, {
      Image: image,
      User: "1000:1000",
      Cmd: ["sleep", "infinity"],
      Labels: { "quokkabot.smoke": "true" },
      HostConfig: { Runtime: "runc", Init: true, NetworkMode: "none", RestartPolicy: { Name: "no" } },
    });
  } catch (error) {
    if (dockerMissing(error)) throw new Error(`Image ${image} is not present locally; run \`docker pull ${image}\` first`, { cause: error });
    throw error;
  }
  try {
    await docker.startContainer(container);
    await step("container", async () => {
      const inspect: ContainerInspect = await docker.inspectContainer(container);
      check("container", inspect.State.Running && inspect.HostConfig.Runtime === "runc", `running=${inspect.State.Running} runtime=${inspect.HostConfig.Runtime} startedAt=${inspect.State.StartedAt}`);
      const stats = await docker.stats(container);
      check("one-shot stats", typeof stats.memory_stats.usage === "number" && stats.memory_stats.usage > 0, `memory_stats.usage=${stats.memory_stats.usage}`);
    });

    await step("stdin echo, stderr, exit 3", async () => {
      const input = Buffer.from("first line\nsecond line with UTF-8: ąčęėįšųūž – ✓\nno trailing newline", "utf8");
      const result = await execOnce(execBody(["sh", "-c", "cat; printf 'to-stderr\\n' >&2; exit 3"]), input);
      check("stdin echo stdout", result.stdout.equals(input), `${result.stdout.length} bytes, equal to the ${input.length} stdin bytes`);
      check("stdin echo stderr", result.stderr.toString("utf8") === "to-stderr\n", JSON.stringify(result.stderr.toString("utf8")));
      check("stdin echo exit code", result.exit.ExitCode === 3, `ExitCode=${result.exit.ExitCode} Running=${result.exit.Running}`);
    });

    await step("exec inspect states", async () => {
      const { Id } = await docker.createExec(container, execBody(["true"]));
      const created = await docker.inspectExec(Id);
      // reconcile() treats "not running, no exit code" as lost; a created exec that never started must look like that.
      check("created, never started exec", !created.Running && created.ExitCode === null, `Running=${created.Running} ExitCode=${created.ExitCode}`);
      let missing: unknown = null;
      try { await docker.inspectExec("0".repeat(64)); } catch (error) { missing = error; }
      check("unknown exec id", dockerMissing(missing), missing instanceof DockerError ? missing.message : `no 404, got ${String(missing)}`);
    });

    await step("TTY sh with resize", async () => {
      const body = execBody(["sh"], { Tty: true, Env: ["TERM=xterm-256color", "PS1=smoke$ "] });
      const { Id } = await docker.createExec(container, body);
      const stream = await docker.startExec(Id, true);
      const reader = new TtyReader(stream);
      // Resize at once, as a browser terminal does on open, before the shell has printed anything.
      await docker.resizeExec(Id, 100, 40);
      const running = await docker.inspectExec(Id);
      check("TTY exec running", running.Running && running.ExitCode === null, `Running=${running.Running} ExitCode=${running.ExitCode}`);
      stream.write("stty size; echo marker-$((6*7))\n");
      await reader.waitFor(/marker-42/, "marker-42");
      check("TTY command output", /marker-42/.test(reader.text), "shell evaluated $((6*7)) and printed marker-42");
      check("TTY resize applied", /(^|\n)40 100\r?\n/.test(reader.text), "stty size printed \"40 100\" (rows cols)");
      stream.write("exit 5\n");
      await reader.end();
      const exit = await waitExit(Id);
      check("TTY exit code", exit.ExitCode === 5, `ExitCode=${exit.ExitCode}; transcript ${JSON.stringify(reader.text)}`);
    });

    await step("output over 1 MB on both streams", async () => {
      const result = await execOnce(execBody(["sh", "-c", "seq 1 300000 & seq 1 200000 >&2; wait"], { AttachStdin: false }), Buffer.alloc(0));
      const stdout = Buffer.from(seq(300_000));
      const stderr = Buffer.from(seq(200_000));
      check("large stdout", result.stdout.equals(stdout), `${result.stdout.length} of ${stdout.length} bytes, first difference at ${firstDifference(result.stdout, stdout)}`);
      check("large stderr", result.stderr.equals(stderr), `${result.stderr.length} of ${stderr.length} bytes, first difference at ${firstDifference(result.stderr, stderr)}`);
      check("large exit code", result.exit.ExitCode === 0, `ExitCode=${result.exit.ExitCode}, ${result.chunks} demultiplexed chunks in ${result.ms} ms`);
    });

    await step("4 MiB of random stdin through cat", async () => {
      // File helper requests and prompts reach the sandbox on stdin; large ones must arrive intact.
      const input = randomBytes(4 * 1024 * 1024);
      const result = await execOnce(execBody(["cat"]), input);
      check("large stdin round trip", result.stdout.equals(input) && result.exit.ExitCode === 0, `${result.stdout.length} of ${input.length} bytes, first difference at ${firstDifference(result.stdout, input)}, ExitCode=${result.exit.ExitCode}, ${result.ms} ms`);
    });

    await step("binary file with all 256 byte values", async () => {
      // 4096 repetitions of 0x00..0xff (1 MiB), so the bytes span many multiplexed frames.
      const block = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
      const bytes = Buffer.concat(Array.from({ length: 4096 }, () => block));
      const digest = createHash("sha256").update(bytes).digest("hex");
      const written = await execOnce(execBody(["sh", "-c", "cat > /tmp/all-bytes && sha256sum /tmp/all-bytes"]), bytes);
      check("binary file written via stdin", written.exit.ExitCode === 0 && written.stdout.toString("utf8").startsWith(`${digest} `), `in-container sha256 ${written.stdout.toString("utf8").split(" ")[0]} (expected ${digest})`);
      const read = await execOnce(execBody(["cat", "/tmp/all-bytes"], { AttachStdin: false }), Buffer.alloc(0));
      check("binary cat stdout", read.stdout.equals(bytes) && read.stderr.length === 0 && read.exit.ExitCode === 0, `${read.stdout.length} of ${bytes.length} bytes, first difference at ${firstDifference(read.stdout, bytes)}, ExitCode=${read.exit.ExitCode}`);
      const seen = new Set(read.stdout);
      check("binary cat byte values", seen.size === 256, `${seen.size} distinct byte values`);
    });

    await step("missing executable", async () => {
      // Shows how a missing helper such as /opt/quokkabot/bin/qb-files surfaces through the multiplexed stream.
      const result = await execOnce(execBody(["/opt/quokkabot/bin/missing-helper"], { AttachStdin: false }), Buffer.alloc(0));
      const message = (result.stdout.toString("utf8") + result.stderr.toString("utf8")).trim();
      check("missing executable", result.exit.ExitCode === 126 || result.exit.ExitCode === 127, `ExitCode=${result.exit.ExitCode}, stdout ${result.stdout.length} bytes, stderr ${result.stderr.length} bytes: ${JSON.stringify(message.slice(0, 200))}`);
    });

    group = "supervisor assumption";
    await step("TTY hangup on stream close", async () => {
      // server.ts relayTerminal destroys the hijacked stream when the owner disconnects and expects that to end
      // the shell (the brief: "on close, the shell gets SIGHUP by closing the stream").
      const body = execBody(["sh"], { Tty: true, Env: ["TERM=xterm-256color", "PS1=hangup$ "] });
      const { Id } = await docker.createExec(container, body);
      const stream = await docker.startExec(Id, true);
      const reader = new TtyReader(stream);
      await reader.waitFor(/hangup\$ /, "the prompt");
      stream.destroy();
      await reader.end().catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") throw error; });
      let state = await docker.inspectExec(Id);
      for (let attempt = 0; attempt < 120 && state.Running; attempt++) { await delay(25); state = await docker.inspectExec(Id); }
      check("TTY shell ends when the stream closes", !state.Running, `~3 s after the client closed the stream: Running=${state.Running} ExitCode=${state.ExitCode}`);
    });

    // Last, because when the assumption is wrong it stops the container.
    let pending: string | null = null;
    await step("tools reset keeps the sandbox alive", async () => {
      // An exec created now and started after the reset exercises the client's refused exec start path.
      pending = (await docker.createExec(container, execBody(["true"], { AttachStdin: false }))).Id;
      // supervisor.ts resetTools runs exactly this command and expects only PID 1 to survive.
      const { Id } = await docker.createExec(container, execBody(["pkill", "-KILL", "-u", "1000"], { AttachStdin: false }));
      const stream = await docker.startExec(Id, false);
      stream.end();
      for await (const _chunk of dockerOutput(stream)) { /* pkill prints nothing on success */ }
      await delay(500);
      const inspect = await docker.inspectContainer(container);
      check("tools reset keeps the sandbox alive", inspect.State.Running, `pkill -KILL -u 1000 under tini as PID 1: container Running=${inspect.State.Running} Status=${inspect.State.Status}`);
    });

    group = "client";
    await step("stop and kill of a stopped container", async () => {
      // supervisor.ts stop() tolerates 304 and kill() tolerates 409; both must be what the Engine sends.
      if ((await docker.inspectContainer(container)).State.Running) await docker.stopContainer(container);
      const stopped = await docker.inspectContainer(container);
      check("container stopped", !stopped.State.Running, `Status=${stopped.State.Status}`);
      let stopError: unknown = null;
      try { await docker.stopContainer(container); } catch (error) { stopError = error; }
      check("stop when stopped", stopError instanceof DockerError && stopError.statusCode === 304, stopError instanceof Error ? stopError.message : "no error");
      let killError: unknown = null;
      try { await docker.killContainer(container); } catch (error) { killError = error; }
      check("kill when stopped", killError instanceof DockerError && killError.statusCode === 409, killError instanceof Error ? killError.message : "no error");
    });

    await step("refused exec start", async () => {
      if (pending === null) throw new Error("no exec was created before the reset");
      let refused: unknown = null;
      try { (await docker.startExec(pending, false)).destroy(); } catch (error) { refused = error; }
      check("refused exec start", refused instanceof DockerError && refused.statusCode >= 400 && refused.engineMessage !== null, refused instanceof Error ? refused.message : `no error, got ${String(refused)}`);
    });
  } finally {
    await docker.removeContainer(container);
    let gone: unknown = null;
    try { await docker.inspectContainer(container); } catch (error) { gone = error; }
    if (!dockerMissing(gone)) { failures.client.push("remove container"); process.stdout.write(`FAIL [client] remove container: ${container} still exists\n`); }
    else { passed.client++; process.stdout.write(`ok   [client] remove container: ${container} is gone (inspect returns 404)\n`); }
    docker.close();
  }
}

try {
  await main();
} catch (error) {
  failures.client.push("setup");
  process.stdout.write(`FAIL [client] setup: ${error instanceof Error ? error.message : String(error)}\n`);
  docker.close();
}
for (const name of ["client", "supervisor assumption"] as const) {
  process.stdout.write(`${name}: ${passed[name]} checks passed, ${failures[name].length} failed${failures[name].length === 0 ? "" : ` (${failures[name].join(", ")})`}\n`);
}
process.exitCode = failures.client.length === 0 && failures["supervisor assumption"].length === 0 ? 0 : 1;
