import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStatus } from "@quokkabot/shared";
import { SupervisorConfig } from "../src/config.js";
import { DockerError, type ContainerInspect } from "../src/docker.js";
import { Supervisor } from "../src/supervisor.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const names = ["cli-state", "workspace", "browser-profile", "staging", "run", "downloads"];
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qb-wipe-"));
  roots.push(root);
  const image = `quokkabot/test@sha256:${"a".repeat(64)}`;
  const config = SupervisorConfig.parse({
    socketPath: join(root, "api.sock"), dockerSocket: join(root, "docker.sock"), tokenFile: join(root, "token"),
    dataRoot: join(root, "data"), dataMarker: ".quokkabot-volume", runtime: "runsc", viewOrigin: "https://view.quokkabot.test",
    images: { cli: image, tools: image, browser: image },
    agents: [{ agentId, index: 1, networks: {
      cli: { name: "qb-cli-1", subnet: "10.231.1.0/24", address: "10.231.1.10" },
      browser: { name: "qb-browser-1", subnet: "10.232.1.0/24", address: "10.232.1.10" },
    }, egressProxy: { cli: "http://10.231.1.2:3128", browser: "http://10.232.1.2:3128" }, controlAddress: { cli: "10.231.1.3" }, secretsDir: join(root, "secrets") }],
    limits: { cli: { memoryMb: 1024, cpus: 1, pids: 512 }, tools: { memoryMb: 1024, cpus: 1, pids: 512 }, browser: { memoryMb: 2048, cpus: 1, pids: 512, shmMb: 1024 } },
  });
  await mkdir(config.dataRoot);
  await writeFile(join(config.dataRoot, config.dataMarker), "encrypted");
  const supervisor = new Supervisor(config, { own: async () => undefined, log: () => undefined });
  const inspect = vi.spyOn(supervisor.docker, "inspectContainer").mockRejectedValue(new DockerError(404, "inspect"));
  const remove = vi.spyOn(supervisor.docker, "removeContainer").mockResolvedValue();
  await supervisor.initialize();
  inspect.mockImplementation(async name => ({ Id: name, Config: { Labels: { "quokkabot.agent": agentId, "quokkabot.sandbox": name.split("-")[1] } } }) as unknown as ContainerInspect);
  const path = join(config.dataRoot, "agents/1");
  for (const name of names) {
    await mkdir(join(path, name, "nested"));
    await writeFile(join(path, name, "nested/private"), name);
  }
  return { root, config, supervisor, agent: config.agents[0]!, path, inspect, remove };
}

describe("supervisor agent wipe without sockets", () => {
  it("removes the three labelled containers, empties data and preserves each directory's metadata", async () => {
    const { supervisor, agent, path, remove, config } = await fixture();
    await chmod(join(path, "downloads"), 0o750);
    const before = await Promise.all(names.map(name => lstat(join(path, name))));
    await mkdir(join(config.dataRoot, "agents/2"));
    await writeFile(join(config.dataRoot, "agents/2/keep"), "other agent");
    const record = { status: RunStatus.parse({ runId, agentId, state: "exited", exitCode: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), lines: 0, lastOutputAt: null }), execId: null, cancelRequested: false };
    await supervisor.runs.reserve(record);
    await supervisor.runs.append(record, [{ stream: "stdout", line: "private transcript" }]);
    // The Claude sign-in all agents share outlives any one agent.
    const signIn = await supervisor.claudeToken.save("33333333-3333-4333-8333-333333333333", `sk-ant-oat01-${"a".repeat(95)}`);
    await supervisor.wipe(agent);
    expect(await supervisor.claudeSignIn()).toEqual(signIn);
    expect(remove.mock.calls.map(call => call[0]).sort()).toEqual(["qb-browser-1", "qb-cli-1", "qb-tools-1"]);
    for (const [index, name] of names.entries()) {
      expect(await readdir(join(path, name))).toEqual([]);
      const after = await lstat(join(path, name));
      expect([after.ino, after.uid, after.gid, after.mode]).toEqual([before[index]!.ino, before[index]!.uid, before[index]!.gid, before[index]!.mode]);
    }
    expect(await readFile(join(config.dataRoot, "agents/2/keep"), "utf8")).toBe("other agent");
    expect(supervisor.runs.records.has(runId)).toBe(false);
    expect(await readdir(supervisor.runs.root)).toEqual([]);
    await supervisor.wipe(agent);
  });
  it.each(["run", "terminal", "cleanup"])("refuses a wipe while a %s is active", async kind => {
    const { supervisor, agent, remove, path } = await fixture();
    if (kind === "run") supervisor.runs.records.set(runId, { status: RunStatus.parse({ runId, agentId, state: "running", exitCode: null, startedAt: new Date().toISOString(), endedAt: null, lines: 0, lastOutputAt: null }), execId: "exec", cancelRequested: false });
    else {
      const internal = supervisor as unknown as { terminals: Set<string>; cleaning: Set<string> };
      (kind === "terminal" ? internal.terminals : internal.cleaning).add(agentId);
    }
    await expect(supervisor.wipe(agent)).rejects.toMatchObject({ status: 409, code: "busy" });
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(join(path, "workspace/nested/private"), "utf8")).toBe("workspace");
  });
  it("leaves the killed latch and all data alone while killed", async () => {
    const { supervisor, agent, path, remove } = await fixture();
    const latch = JSON.stringify({ killedAt: new Date().toISOString() });
    await writeFile(join(path, "killed.json"), latch);
    await expect(supervisor.wipe(agent)).rejects.toMatchObject({ status: 409, code: "killed" });
    expect(await readFile(join(path, "killed.json"), "utf8")).toBe(latch);
    expect(remove).not.toHaveBeenCalled();
  });
  it("unlinks nested symlinks without touching their targets", async () => {
    const { root, supervisor, agent, path } = await fixture();
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside/keep"), "safe");
    await symlink(join(root, "outside"), join(path, "workspace/nested/link"));
    await supervisor.wipe(agent);
    expect(await readFile(join(root, "outside/keep"), "utf8")).toBe("safe");
  });
  it.each(["workspace", "parent"])("refuses a symlink replacing the %s directory before deletion", async target => {
    const { root, supervisor, agent, path, remove } = await fixture();
    const replaced = target === "parent" ? path : join(path, "workspace");
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside/keep"), "safe");
    await rm(replaced, { recursive: true });
    await symlink(join(root, "outside"), replaced);
    await expect(supervisor.wipe(agent)).rejects.toThrow("Refusing non-directory");
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(join(root, "outside/keep"), "utf8")).toBe("safe");
  });
  it("uses the lifecycle lock and leaves data intact on a Docker failure", async () => {
    const { supervisor, agent, remove, path } = await fixture();
    let release!: () => void;
    const block = supervisor.exclusive(agent, () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const wipe = supervisor.wipe(agent);
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();
    remove.mockRejectedValueOnce(new Error("engine unavailable"));
    release();
    await block;
    await expect(wipe).rejects.toThrow("engine unavailable");
    expect(await readFile(join(path, "workspace/nested/private"), "utf8")).toBe("workspace");
    await supervisor.wipe(agent);
    expect(await readdir(join(path, "workspace"))).toEqual([]);
  });
});
