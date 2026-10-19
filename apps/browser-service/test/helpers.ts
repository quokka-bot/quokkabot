import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCommandResult } from "@quokkabot/shared";
import type { CdpConnection } from "../src/cdp.js";
import { createBrowserService } from "../src/service.js";
import type { BrowserService } from "../src/service.js";
import { nodeProcessRunner, systemClock } from "../src/runtime.js";
import type { Clock, ManagedProcess, ProcessRunner } from "../src/runtime.js";

export const RUN_ID = "03dd93a9-2bce-4eb0-aec0-d974be4b3954";
export const GUID = "6301f656-5670-4518-8065-56e857e301fe";
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const fakeExecutable = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(process.env.TEST_LOG, JSON.stringify(argv) + '\n');
const command = argv.slice(7);
const path = process.env.TEST_CONFIG;
const config = JSON.parse(readFileSync(path, 'utf8'));
const reply = (data) => { process.stdout.write(JSON.stringify({success:true,data})); };
if (config.hang === command[0]) { setInterval(() => {}, 1000); }
else if (config.crash === command[0]) { process.kill(process.pid, 'SIGKILL'); }
else if (config.malformed === command[0]) { process.stdout.write('invalid json secret-canary'); }
else if (config.reject === command[0]) { process.stdout.write(JSON.stringify({success:false,error:'secret-canary'})); }
else {
  if (command[0] === 'stream') {
    const pid = join(process.env.AGENT_BROWSER_SOCKET_DIR, 'quokkabot.pid');
    if (!existsSync(pid) || readFileSync(pid, 'utf8') !== process.env.TEST_DAEMON_PID) writeFileSync(pid, process.env.TEST_DAEMON_PID);
    // Like agent-browser 0.39.1: disabling a stream that is already off answers success:false.
    if (command[1] === 'disable' && !(config.enabled ?? false)) {
      process.stdout.write(JSON.stringify({success:false,data:null,error:'Streaming is not enabled for this session'}));
    } else {
      if (command[1] === 'disable' && config.disableWorks !== false) config.enabled = false;
      reply(command[1] === 'status' ? {enabled:config.enabled ?? false} : {});
    }
  } else if (command[0] === 'tab') {
    if (command[1] === 'list') reply({tabs: config.tabs});
    else if (command[1] === 'new') {
      for (const tab of config.tabs) tab.active = false;
      const number = (config.nextTab ?? 1) + 1;
      config.nextTab = number;
      config.tabs.push({tabId:'t'+number,targetId:'target_'+number,url:command[2],title:'Opened',active:true});
      reply({});
    } else if (command[1] === 'close') {
      config.tabs = config.tabs.filter((tab) => tab.targetId !== command[2]); reply({});
    } else {
      // Like agent-browser 0.39.1: any tab switch, even to the active tab, drops every element ref.
      for (const tab of config.tabs) tab.active = tab.targetId === command[1];
      config.refEpoch = (config.refEpoch ?? 0) + 1;
      reply({});
    }
  } else if (command[0] === 'snapshot') {
    const refs = config.refs ?? Object.fromEntries(config.snapshot.split('\n').flatMap((line) => {
      const match = /- (\w+) "((?:\\.|[^"\\])*)" \[ref=(e[0-9]+)\]/.exec(line);
      return match ? [[match[3], {role:match[1],name:match[2]}]] : [];
    }));
    config.snapshotEpoch = config.refEpoch ?? 0;
    reply({snapshot:config.snapshot,refs});
  }
  else if ((command[1]?.startsWith('@') || command[0] === 'get' && command[2]?.startsWith('@')) && (config.snapshotEpoch ?? 0) !== (config.refEpoch ?? 0)) {
    process.stdout.write(JSON.stringify({success:false,data:null,error:'Unknown ref: ' + command[1].slice(1)}));
  }
  else if (command[0] === 'get' && command[1] === 'attr') {
    reply({attribute:command[3],value:config.attributes?.[command[2].slice(1)]?.[command[3]] ?? null});
  } else if (command[0] === 'open') {
    const tab = config.tabs.find((tab) => tab.active); tab.url = command[1]; tab.title = 'Navigated'; reply({});
  } else if (command[0] === 'screenshot') {
    const content = Buffer.from(config.png, 'base64');
    writeFileSync(command[1], config.largeScreenshot ? Buffer.concat([content,Buffer.alloc(1600000)]) : content);
    reply({path:command[1]});
  } else reply({});
  writeFileSync(path, JSON.stringify(config));
}
`;
export class FakeCdp extends EventEmitter implements CdpConnection {
  connected = false;
  calls: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  onCloseBrowser: (() => void) | undefined;
  onSend: ((method: string) => void) | undefined;
  cookies: Record<string, unknown>[] = [];
  targets: { targetId?: string; type: string; url: string }[] = [{ type: "page", url: "https://example.com/" }];
  failMethod: string | undefined;
  frames: FakeFrame[] = [{
    id: "frame_main", origin: "https://example.com", parentId: null,
    field: { tag: "input", type: "password", autocomplete: "current-password", maxLength: -1, inputMode: "", disabled: false, readOnly: false, hints: "" },
  }];
  private worlds = new Map<string, string>();
  private nextWorld = new Map<string, number>();
  async connect(): Promise<void> { this.connected = true; }
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, ...(sessionId === undefined ? {} : { sessionId }) });
    this.onSend?.(method);
    if (this.failMethod === method) throw new Error("CDP failure secret-canary");
    if (method === "Storage.getCookies") return { cookies: structuredClone(this.cookies) };
    if (method === "Storage.clearCookies") this.cookies = [];
    if (method === "Storage.setCookies") {
      this.cookies = (params.cookies as Record<string, unknown>[]).map((cookie) => ({
        ...cookie, session: cookie.expires === undefined, expires: cookie.expires ?? -1,
      }));
    }
    if (method === "Target.getTargets") return { targetInfos: [
      ...this.targets.map((target, index) => ({ targetId: `target_${index + 1}`, ...target })),
      ...this.frames.filter((frame) => frame.outOfProcess).map((frame) => ({ targetId: frame.id, type: "iframe", url: `${frame.origin}/login` })),
    ] };
    if (method === "Browser.close") this.onCloseBrowser?.();
    if (method === "Target.attachToTarget") return { sessionId: `session_${String(params.targetId)}` };
    if (method === "Page.getFrameTree") {
      function tree(frames: FakeFrame[], parentId: string | null): unknown {
        const frame = frames.find((item) => item.parentId === parentId);
        if (!frame) throw new Error("Fake frame tree has no root");
        function branch(frame: FakeFrame): unknown {
          const children = frames.filter((item) => item.parentId === frame.id);
          return { frame: { id: frame.id, url: `${frame.origin}/login`, securityOrigin: frame.origin },
            ...(children.length === 0 ? {} : { childFrames: children.map(branch) }) };
        }
        return branch(frame);
      }
      return { frameTree: tree(this.frames.filter((frame) => (frame.pageTarget ?? "target_1") === sessionId?.slice("session_".length)), null) };
    }
    if (method === "Page.createIsolatedWorld") {
      const frame = this.frames.find((frame) => frame.id === params.frameId);
      if (!sessionId || params.worldName !== "quokkabot-secret-fill" || params.grantUniveralAccess !== false ||
          !frame) throw new Error("Unsafe isolated world creation");
      if (frame.outOfProcess && sessionId !== `session_${frame.id}`) throw new Error("Remote frame needs its own target session");
      const id = (this.nextWorld.get(sessionId) ?? 0) + 1;
      this.nextWorld.set(sessionId, id);
      this.worlds.set(`${sessionId}:${id}`, String(params.frameId));
      return { executionContextId: id };
    }
    if (method === "Runtime.evaluate") {
      const frameId = this.worlds.get(`${sessionId}:${Number(params.contextId)}`);
      if (!sessionId || frameId === undefined || params.returnByValue !== true || params.silent !== true) {
        throw new Error("Fake CDP refuses main-world or unsafe evaluation");
      }
      const frame = this.frames.find((item) => item.id === frameId);
      if (!frame) throw new Error("Isolated world frame disappeared");
      return { result: { type: "object", ...(frame.field === null ? { subtype: "null" } : {}), value: runInFakePage(`function () { return ${String(params.expression)}; }`, frame, []) } };
    }
    if (method === "Runtime.callFunctionOn") {
      const frameId = this.worlds.get(`${sessionId}:${Number(params.executionContextId)}`);
      if (!sessionId || frameId === undefined || params.returnByValue !== true || params.silent !== true || "objectId" in params) {
        throw new Error("Fake CDP refuses main-world or unsafe calls");
      }
      const frame = this.frames.find((item) => item.id === frameId);
      if (!frame) throw new Error("Isolated world frame disappeared");
      const args = (params.arguments as { value: unknown }[]).map((argument) => argument.value);
      return { result: { type: "string", value: runInFakePage(String(params.functionDeclaration), frame, args) } };
    }
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } };
    if (method === "Page.captureScreenshot") return { data: PNG.toString("base64") };
    return {};
  }
  close(): void { if (this.connected) { this.connected = false; this.emit("disconnect"); } }
  event(method: string, params: unknown, sessionId?: string): void { this.emit("event", method, params, sessionId); }
}
export interface FakeFrame {
  id: string;
  origin: string;
  parentId: string | null;
  outOfProcess?: boolean;
  pageTarget?: string;
  field: { tag: string; type: string; autocomplete: string; maxLength: number; inputMode: string; disabled: boolean; readOnly: boolean; hints: string } | null;
  // What the page's field holds after an insertion.
  inserted?: string;
}

// Runs the browser service's in-page function against a minimal DOM built from the fake frame, so the real check
// and insertion code is what the tests exercise.
function runInFakePage(functionDeclaration: string, frame: FakeFrame, args: unknown[]): unknown {
  class HTMLInputElement {
    localName = "input"; shadowRoot = null; value = "";
    constructor(readonly spec: NonNullable<FakeFrame["field"]>) {}
    get type(): string { return this.spec.type; }
    get autocomplete(): string { return this.spec.autocomplete; }
    get maxLength(): number { return this.spec.maxLength; }
    get inputMode(): string { return this.spec.inputMode; }
    get disabled(): boolean { return this.spec.disabled; }
    get readOnly(): boolean { return this.spec.readOnly; }
    get name(): string { return this.spec.hints; }
    id = ""; placeholder = "";
    getAttribute(): string | null { return null; }
    select(): void { this.value = ""; }
  }
  const spec = frame.field;
  const element = spec === null ? null : spec.tag === "input" ? new HTMLInputElement(spec) : { localName: spec.tag, shadowRoot: null };
  const document = {
    hasFocus: () => element !== null,
    activeElement: element,
    execCommand: (command: string, _ui: boolean, text: string) => {
      if (command !== "insertText" || !(element instanceof HTMLInputElement)) return false;
      element.value = element.maxLength > 0 ? text.slice(0, element.maxLength) : text;
      frame.inserted = element.value;
      return true;
    },
  };
  return runInNewContext(`(${functionDeclaration})(...args)`, { document, location: { origin: frame.origin }, HTMLInputElement, URL, args });
}
export interface Harness {
  service: BrowserService;
  root: string;
  cdp: FakeCdp;
  config(patch: Record<string, unknown>): Promise<void>;
  calls(): Promise<string[][]>;
  command(op: unknown, generation?: number, id?: string): Promise<BrowserCommandResult>;
  request(method: string, path: string, body?: unknown): ReturnType<BrowserService["handle"]>;
  cleanup(): Promise<void>;
  runner: ProcessRunner;
  chromeExit(): void;
  starts: { executable: string; argv: readonly string[]; env: NodeJS.ProcessEnv }[];
}
export async function harness(options: { clock?: Clock; timeoutMs?: number; config?: Record<string, unknown>; env?: NodeJS.ProcessEnv } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "quokkabot-browser-test-"));
  const configPath = join(root, "config.json");
  const log = join(root, "argv.jsonl");
  const executable = join(root, "agent-browser.mjs");
  await writeFile(executable, fakeExecutable, { mode: 0o755 });
  await writeFile(log, "");
  const initial = {
    tabs: [{ tabId: "t1", targetId: "target_1", title: "Example", url: "https://example.com/", active: true }],
    snapshot: '- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]: ••••••\n- button "Save" [ref=e3]',
    png: PNG.toString("base64"), ...options.config,
  };
  await writeFile(configPath, JSON.stringify(initial));
  const cdp = new FakeCdp();
  let exit!: () => void;
  const starts: Harness["starts"] = [];
  // A real, otherwise idle daemon process lets takeover tests verify SIGKILL and CLI exit independently.
  const daemons: ChildProcess[] = [];
  let daemon: ChildProcess | undefined;
  const runner: ProcessRunner = {
    run(executable, argv, runOptions) {
      if (argv[7] === "stream" && (daemon === undefined || daemon.exitCode !== null || daemon.signalCode !== null)) {
        daemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        daemons.push(daemon);
      }
      if (daemon?.pid === undefined) throw new Error("Fake daemon has no pid");
      return nodeProcessRunner.run(executable, argv, { ...runOptions, env: { ...runOptions.env, TEST_DAEMON_PID: String(daemon.pid) } });
    },
    start(executable, argv, runOptions): ManagedProcess {
      starts.push({ executable, argv, env: runOptions.env });
      return { exited: new Promise<void>((resolve) => { exit = resolve; }), kill: () => exit() };
    },
  };
  cdp.onCloseBrowser = () => exit();
  const clock = options.clock ?? {
    ...systemClock,
    setTimeout(callback: () => void, milliseconds: number) {
      const duration = milliseconds === 1000 ? 3_600_000 : milliseconds === 2000 ? 40 : milliseconds === 15_000 ? 80 : milliseconds;
      return setTimeout(callback, duration);
    },
  };
  const service = await createBrowserService({
    token: "test-token", chrome: "/fake/chrome", agentBrowser: executable, proxy: "http://egress:3128",
    cdp, runner, clock, roots: { staging: join(root, "staging"), scratch: join(root, "scratch"), daemon: join(root, "daemon") },
    env: { PATH: process.env.PATH, HOME: root, TEST_LOG: log, TEST_CONFIG: configPath, NODE_ENV: "test", ...options.env },
    commandTimeoutMs: options.timeoutMs ?? 3000,
  });
  await service.start();
  await service.setControlLease({ holder: "agent", generation: 2, expiresAt: null });
  let number = 0;
  return {
    service, root, cdp, runner, starts, chromeExit: () => exit(),
    config: async (patch) => { const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>; await writeFile(configPath, JSON.stringify({ ...config, ...patch })); },
    calls: async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    command: (op, generation = 2, id) => service.execute({ commandId: id ?? `command_${++number}`, runId: RUN_ID, generation, op }),
    request: (method, path, body) => service.handle({ method, path, body, authorization: "Bearer test-token" }),
    cleanup: async () => {
      try { await service.shutdown(); }
      finally {
        for (const child of daemons) {
          if (child.exitCode !== null || child.signalCode !== null) continue;
          await new Promise<void>((resolve) => { child.once("exit", resolve); child.kill("SIGKILL"); });
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
export async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Test condition did not become true");
}
