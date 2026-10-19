import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, rmSync } from "node:fs";
import { lstat, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  BrowserCommandRequest, BrowserCommandResult, ControlLease, DownloadId, ElementRef, IsoTime, LIMITS,
  MUTATING_BROWSER_OPS, SecretFillRequest, SiteDataClearRequest, TabRef,
} from "@quokkabot/shared";
import type { BrowserOp, TabInfo } from "@quokkabot/shared";
import type { CdpConnection } from "./cdp.js";
import { DownloadError, Downloads } from "./downloads.js";
import { AGENT_BROWSER_ARGV, CHROME_PROFILE_DIR, chromeArgv, UncertainProcessError } from "./runtime.js";
import type { Clock, ManagedProcess, ProcessRunner } from "./runtime.js";
import { maskSnapshot } from "./snapshot.js";
import { clearSiteData, SiteDataClearError } from "./site-data.js";
import { fillSecret, SecretFillError } from "./secret-fill.js";
import type { SecretFillSend } from "./secret-fill.js";

export interface BrowserServiceDependencies {
  token: string;
  chrome: string;
  agentBrowser: string;
  proxy: string;
  runner: ProcessRunner;
  cdp: CdpConnection;
  clock: Clock;
  roots: { staging: string; scratch: string; daemon: string };
  env: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
}
export interface ServiceResponse {
  statusCode: number;
  body?: unknown;
  headers?: Record<string, string>;
  stream?: Readable;
}
export interface ServiceRequest { method: string; path: string; authorization?: string; body?: unknown }
interface Tab {
  ref: string;
  agentId: string;
  targetId: string;
  url: string;
  title: string;
  active: boolean;
  generation: number;
  documentEpoch: number;
  // Counts top-level document loads only. A saved login typed into the page blocks screenshots of that document.
  mainEpoch: number;
  secretEpoch?: number;
  sessionId?: string;
  frameSessions: Map<string, string>;
  snapshot?: { text: string; refs: Set<string>; passwords: Set<string>; interactiveOnly: boolean };
}
type CommandIdentity = Pick<BrowserCommandRequest, "commandId" | "runId" | "generation">;
interface Running { request: CommandIdentity; secret: boolean; done: Promise<void>; abort: AbortController; tainted: boolean; dispatched: boolean }
class OperationError extends Error {
  constructor(readonly status: BrowserCommandResult["status"], message: string) { super(message); }
}
const AgentTab = z.object({
  tabId: z.string().regex(/^t[0-9]+$/), targetId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  url: z.string(), title: z.string(), active: z.boolean(),
});
function safeArgument(value: string): string {
  // The pinned CLI documentation does not promise end-of-options handling for these commands.
  // Reject flag-shaped operands before spawning, including operands of --text and --url.
  if (value.startsWith("-") || value.includes("\0")) throw new OperationError("invalid", "argument must not start with '-' or contain NUL");
  return value;
}
function assertInput(op: BrowserOp): void {
  if (op.op === "type") safeArgument(op.text);
  if (op.op === "select") safeArgument(op.option);
  if (op.op === "wait" && (op.until.kind === "text" || op.until.kind === "text_gone")) safeArgument(op.until.text);
  if (op.op === "wait" && op.until.kind === "url_contains") safeArgument(op.until.value);
}
function waitArgv(op: Extract<BrowserOp, { op: "wait" }>): string[] {
  const timeout = ["--timeout", String(op.timeoutS * 1000)];
  switch (op.until.kind) {
    case "text": return ["wait", "--text", safeArgument(op.until.text), ...timeout];
    // This selector is generated here from a quoted literal, never accepted as a selector from callers.
    case "text_gone": return ["wait", `text=${JSON.stringify(safeArgument(op.until.text))}`, "--state", "hidden", ...timeout];
    case "url_contains": {
      const literal = safeArgument(op.until.value).replace(/[\\*?{}[\]]/g, "\\$&");
      return ["wait", "--url", `**${literal}**`, ...timeout];
    }
    case "load": return ["wait", "--load", "load", ...timeout];
    case "network_idle": return ["wait", "--load", "networkidle", ...timeout];
  }
}

export async function createBrowserService(deps: BrowserServiceDependencies) {
  if (!deps.token || !deps.chrome || !deps.agentBrowser) throw new Error("Browser token and executable paths are required");
  const launchArgv = chromeArgv(deps.proxy);
  for (const root of [deps.roots.scratch, deps.roots.daemon]) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Browser service roots must be real directories");
  }
  const downloads = new Downloads(deps.roots.staging, deps.clock, deps.cdp);
  await downloads.load();
  const tokenHash = createHash("sha256").update(`Bearer ${deps.token}`).digest();
  const processEnv: NodeJS.ProcessEnv = { ...deps.env, DISPLAY: ":1", AGENT_BROWSER_SOCKET_DIR: deps.roots.daemon };
  let lease: ControlLease = { holder: "paused", generation: 1, expiresAt: null };
  let leaseChanging = 0;
  let leaseQueue = Promise.resolve();
  let chrome: ManagedProcess | undefined;
  let chromeUp = false;
  let stopping = false;
  let started = false;
  let cdpConfigured = false;
  let ready = false;
  let daemonIdentity: string | undefined;
  let readinessCheck: Promise<boolean> | undefined;
  let maintenance: ReturnType<typeof setTimeout> | undefined;
  let fault: Error | undefined;
  let running: Running | undefined;
  let queue: Promise<void> = Promise.resolve();
  const results = new Map<string, { result: BrowserCommandResult; fingerprint: string }>();
  const pending = new Map<string, { promise: Promise<BrowserCommandResult>; fingerprint: string }>();
  // Keyed fingerprints preserve duplicate detection without retaining values or exposing guesses of short codes.
  const fingerprintKey = randomBytes(32);
  const tabs = new Map<string, Tab>();
  const targetRefs = new Map<string, string>();
  let nextTab = 0;

  // The agent-browser session's active tab, as far as this service knows. agent-browser drops every element ref on any
  // `tab` switch, even to the tab that is already active, so the service switches only when the target changes.
  let activeTarget: string | undefined;
  function dropRefs(): void {
    // Keep counters increasing so a pre-takeover generation cannot alias a new snapshot.
    for (const tab of tabs.values()) delete tab.snapshot;
    activeTarget = undefined;
  }
  deps.cdp.on("disconnect", () => {
    cdpConfigured = false; ready = false; dropRefs();
    for (const tab of tabs.values()) { delete tab.sessionId; tab.frameSessions.clear(); }
  });
  function sessionTab(sessionId: string | undefined): Tab | undefined {
    if (sessionId === undefined) return undefined;
    return [...tabs.values()].find((tab) => tab.sessionId === sessionId || [...tab.frameSessions.values()].includes(sessionId));
  }
  deps.cdp.on("event", (method, params, sessionId) => {
    if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument" || method === "Page.frameDetached") {
      const tab = sessionTab(sessionId);
      if (tab) {
        delete tab.snapshot; tab.documentEpoch += 1;
        const topLevel = method === "Page.frameNavigated" && sessionId === tab.sessionId &&
          z.object({ frame: z.object({ parentId: z.string().optional() }) }).safeParse(params).data?.frame.parentId === undefined;
        if (topLevel) tab.mainEpoch += 1;
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const detached = z.object({ sessionId: z.string() }).safeParse(params);
      if (detached.success) {
        const tab = sessionTab(detached.data.sessionId);
        if (tab) {
          delete tab.snapshot; tab.documentEpoch += 1;
          if (tab.sessionId === detached.data.sessionId) { delete tab.sessionId; tab.mainEpoch += 1; }
          for (const [frame, session] of tab.frameSessions) if (session === detached.data.sessionId) tab.frameSessions.delete(frame);
        }
      }
      return;
    }
    if (!method.startsWith("Browser.download")) return;
    // Capture the association synchronously, before command completion can clear it.
    const association = lease.holder === "agent" ? running?.request : undefined;
    void downloads.event(method, params, association).catch(() => { fault = new Error("Download event processing failed"); ready = false; });
  });
  async function identity(): Promise<string | undefined> {
    const parts: string[] = [];
    for (const suffix of ["pid", "sock"]) {
      const path = join(deps.roots.daemon, `quokkabot.${suffix}`);
      try {
        const info = await stat(path, { bigint: true });
        const content = suffix === "pid" ? await readFile(path, "utf8") : "";
        parts.push(`${suffix}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${content}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return parts.length === 0 ? undefined : parts.join("|");
  }
  async function waitForDaemonExit(pid: number): Promise<void> {
    // SIGKILL delivery is asynchronous. Do not publish owner control while the daemon is still present.
    for (let attempt = 0; attempt < 500; attempt++) {
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw new OperationError("failed", "cannot verify agent-browser daemon termination");
      }
      await new Promise<void>((resolve) => { deps.clock.setTimeout(resolve, 10); });
    }
    throw new OperationError("failed", "agent-browser daemon did not exit after SIGKILL; control lease unchanged");
  }
  async function raw(command: readonly string[], timeoutMs = deps.commandTimeoutMs ?? 30_000): Promise<Record<string, unknown>> {
    const output = await deps.runner.run(deps.agentBrowser, [...AGENT_BROWSER_ARGV, ...command], {
      timeoutMs, env: processEnv, cwd: deps.roots.scratch,
      ...(running === undefined ? {} : { signal: running.abort.signal }),
    });
    let decoded: unknown;
    try { decoded = JSON.parse(output.stdout); }
    catch { throw new UncertainProcessError("agent-browser returned invalid JSON"); }
    const parsed = z
      .object({ success: z.boolean(), data: z.record(z.string(), z.unknown()).nullable().optional(), error: z.string().nullable().optional() })
      .safeParse(decoded);
    if (!parsed.success) {
      // Describe the shape only; values can hold page content.
      const shape = typeof decoded === "object" && decoded !== null ? Object.keys(decoded).join(",") : typeof decoded;
      throw new UncertainProcessError(`agent-browser returned an invalid result (${shape})`);
    }
    if (!parsed.data.success) {
      // Never echo CLI errors: they can include page values, typed secrets, or long snapshots. Known error kinds are
      // reported by name only.
      throw new OperationError("failed", `agent-browser rejected the command${errorKind(parsed.data.error ?? "")}`);
    }
    if (output.exitCode !== 0 || parsed.data.data === undefined || parsed.data.data === null) {
      throw new UncertainProcessError("agent-browser exited without a definite result");
    }
    return parsed.data.data;
  }
  // `stream disable` answers success:false ("Streaming is not enabled") when the stream is already off. The status
  // call that follows is the proof either way.
  async function disableStream(): Promise<void> {
    try {
      await raw(["stream", "disable"]);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
    }
  }
  async function refreshReadiness(): Promise<boolean> {
    if (readinessCheck) return readinessCheck;
    readinessCheck = (async () => {
      if (!chromeUp || !cdpConfigured || !deps.cdp.connected || stopping || fault || running?.abort.signal.aborted) { ready = false; return false; }
      downloads.assertHealthy();
      const before = await identity();
      if (ready && before !== undefined && before === daemonIdentity) return true;
      ready = false;
      dropRefs();
      await disableStream();
      const status = await raw(["stream", "status"]);
      const after = await identity();
      if (status.enabled !== false || after === undefined) return false;
      // A restart between disable and status requires a fresh disable on that new daemon.
      if (before !== undefined && before !== after) {
        await disableStream();
        const secondStatus = await raw(["stream", "status"]);
        if (secondStatus.enabled !== false || await identity() !== after) return false;
      }
      daemonIdentity = after;
      ready = true;
      return true;
    })().catch(() => { ready = false; return false; }).finally(() => { readinessCheck = undefined; });
    return readinessCheck;
  }
  async function invoke(command: readonly string[], timeoutMs?: number, mutating = false): Promise<Record<string, unknown>> {
    if (running?.tainted) throw new OperationError("outcome_unknown", "control lease changed during command");
    if (!await refreshReadiness()) throw new OperationError("failed", "browser not ready");
    if (running?.tainted) throw new OperationError("outcome_unknown", "control lease changed during command");
    if (running && mutating) running.dispatched = true;
    try { return await raw(command, timeoutMs); }
    finally {
      const current = await identity();
      if (current !== daemonIdentity) {
        ready = false;
        dropRefs();
        if (running?.dispatched) running.tainted = true;
        // Close a replacement daemon's stream immediately, even though this command's answer is lost.
        if (!running?.abort.signal.aborted) await refreshReadiness();
        throw new UncertainProcessError("agent-browser daemon changed during command");
      }
    }
  }
  async function listTabs(): Promise<TabInfo[]> {
    const data = await invoke(["tab", "list"]);
    const listed = z.array(AgentTab).parse(data.tabs);
    const present = new Set<string>();
    for (const item of listed) {
      let ref = targetRefs.get(item.targetId);
      if (ref === undefined) {
        ref = TabRef.parse(`t${++nextTab}`);
        targetRefs.set(item.targetId, ref);
      }
      present.add(ref);
      const previous = tabs.get(ref);
      if (previous) {
        if (previous.url !== item.url) { delete previous.snapshot; previous.documentEpoch += 1; }
        Object.assign(previous, { agentId: item.tabId, url: item.url, title: item.title, active: item.active });
      } else tabs.set(ref, { ref, agentId: item.tabId, targetId: item.targetId, url: item.url, title: item.title, active: item.active, generation: 0, documentEpoch: 0, mainEpoch: 0, frameSessions: new Map() });
      if (item.active) activeTarget = item.targetId;
      await ensureSession(tabs.get(ref)!);
    }
    for (const ref of tabs.keys()) if (!present.has(ref)) tabs.delete(ref);
    return [...tabs.values()].map((tab) => ({ tab: tab.ref, url: tab.url, title: tab.title, active: tab.active }));
  }
  async function resolveTab(ref: string): Promise<Tab> {
    await listTabs();
    const tab = tabs.get(ref);
    if (!tab) throw new OperationError("invalid", "unknown tab");
    return tab;
  }
  async function ensureSession(tab: Tab): Promise<string> {
    if (tab.sessionId !== undefined) return tab.sessionId;
    const attached = z.object({ sessionId: z.string().min(1) }).parse(await commandCdp("Target.attachToTarget", { targetId: tab.targetId, flatten: true }));
    tab.sessionId = attached.sessionId;
    try { await commandCdp("Page.enable", {}, attached.sessionId); }
    catch (error) { delete tab.sessionId; throw error; }
    return attached.sessionId;
  }
  async function commandCdp(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const context = running;
    if (!context?.secret) return deps.cdp.send(method, params, sessionId);
    if (context.tainted || context.abort.signal.aborted) throw new OperationError("outcome_unknown", "control lease changed during command");
    // Also fence CDP session attachment during tab preparation, before field inspection starts.
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new OperationError("outcome_unknown", "control lease changed during command"));
      context.abort.signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([deps.cdp.send(method, params, sessionId), cancelled]); }
    finally { context.abort.signal.removeEventListener("abort", abort); }
  }
  async function targetSession<T>(tab: Tab, work: (sessionId: string) => Promise<T>): Promise<T> {
    return work(await ensureSession(tab));
  }
  async function viewport(tab: Tab): Promise<{ x: number; y: number; width: number; height: number }> {
    return targetSession(tab, async (session) => {
      const result = z.object({ cssVisualViewport: z.object({
        pageX: z.number(), pageY: z.number(), clientWidth: z.number().positive(), clientHeight: z.number().positive(),
      }) }).parse(await deps.cdp.send("Page.getLayoutMetrics", {}, session));
      return { x: result.cssVisualViewport.pageX, y: result.cssVisualViewport.pageY,
        width: result.cssVisualViewport.clientWidth, height: result.cssVisualViewport.clientHeight };
    });
  }
  function navigation(tab: Tab): Partial<BrowserCommandResult> { return { tab: tab.ref, url: tab.url, title: tab.title }; }
  function assertRef(tab: Tab, request: { snapshot: number; ref: string }): void {
    if (!tab.snapshot || request.snapshot !== tab.generation || !tab.snapshot.refs.has(request.ref)) {
      throw new OperationError("invalid", "take a new snapshot");
    }
  }
  async function executeSecretFill(request: SecretFillRequest): Promise<Partial<BrowserCommandResult>> {
    await listTabs();
    const tab = tabs.get(request.tab);
    if (!tab) throw new OperationError("invalid", "take a new snapshot");
    assertRef(tab, request);
    if (activeTarget !== tab.targetId) {
      await invoke(["tab", tab.targetId]);
      activeTarget = tab.targetId;
      delete tab.snapshot;
      throw new OperationError("invalid", "take a new snapshot");
    }
    await invoke(["focus", `@${request.ref}`], undefined, true);
    assertRef(tab, request);
    const context = running!;
    const documentEpoch = tab.documentEpoch;
    const session = await ensureSession(tab);
    const send = async (method: string, params: Record<string, unknown> = {}, frameSession = session): Promise<unknown> => {
      const guard = (): void => {
        if (context.tainted || context.abort.signal.aborted || running !== context) {
          throw new OperationError("outcome_unknown", "control lease changed during command");
        }
        // Releasing a key is safe even when Enter's keydown already navigated the page and invalidated refs.
        if (!(method === "Input.dispatchKeyEvent" && params.type === "keyUp")) {
          assertRef(tab, request);
          if (tab.documentEpoch !== documentEpoch) throw new OperationError("invalid", "take a new snapshot");
        }
      };
      guard();
      // Runtime.callFunctionOn is the insertion itself (see INSERT_FUNCTION); the other Runtime and Page calls only read.
      if (method.startsWith("Input.") || method === "Runtime.callFunctionOn") {
        if (await identity() !== daemonIdentity) {
          ready = false; dropRefs();
          throw new OperationError("outcome_unknown", "agent-browser daemon changed during command");
        }
        guard();
        context.dispatched = true;
      }
      return commandCdp(method, params, frameSession);
    };
    const targets = z.object({ targetInfos: z.array(z.object({ targetId: z.string(), type: z.string() })) })
      .parse(await commandCdp("Target.getTargets"));
    const remoteFrames = new Set(targets.targetInfos.filter((target) => target.type === "iframe").map((target) => target.targetId));
    const page = tab;
    const forFrame = async (frameId: string): Promise<SecretFillSend> => {
      // Out-of-process iframes have their own target and context-id namespace. Input still goes to the page target.
      if (!remoteFrames.has(frameId)) return send;
      let frameSession = page.frameSessions.get(frameId);
      if (frameSession === undefined) {
        const attached = z.object({ sessionId: z.string().min(1) }).parse(await commandCdp("Target.attachToTarget", { targetId: frameId, flatten: true }));
        frameSession = attached.sessionId;
        page.frameSessions.set(frameId, frameSession);
        try { await commandCdp("Page.enable", {}, frameSession); }
        catch (error) { page.frameSessions.delete(frameId); throw error; }
      }
      const session = frameSession;
      return (method, params) => send(method, params, session);
    };
    // Captured before the insertion: Enter can load the next page, which must not inherit the block.
    const epochAtFill = page.mainEpoch;
    try {
      await fillSecret(send, forFrame, request, deps.env.NODE_ENV === "test");
    } finally {
      if (context.dispatched) page.secretEpoch = epochAtFill;
    }
    return {};
  }
  async function executeOp(request: BrowserCommandRequest): Promise<Partial<BrowserCommandResult>> {
    const op = request.op;
    assertInput(op);
    if (op.op === "tabs") return { tabs: await listTabs() };
    if (op.op === "open") {
      await invoke(["tab", "new", safeArgument(op.url)], undefined, true);
      await listTabs();
      const active = [...tabs.values()].filter((tab) => tab.active);
      if (active.length !== 1) throw new UncertainProcessError("agent-browser did not identify the opened tab");
      return navigation(active[0]!);
    }
    const tab = await resolveTab(op.tab);
    // Validate refs before switching tabs or dispatching any page input.
    if ("ref" in op) {
      if (!tab.snapshot || op.snapshot !== tab.generation || !tab.snapshot.refs.has(op.ref)) throw new OperationError("invalid", "take a new snapshot");
    }
    if (activeTarget !== tab.targetId) {
      await invoke(["tab", tab.targetId]);
      activeTarget = tab.targetId;
      // The switch cleared agent-browser's refs: an element handle from before it cannot be used.
      if ("ref" in op) {
        delete tab.snapshot;
        throw new OperationError("invalid", "take a new snapshot");
      }
    }
    // Switching to a discarded tab can reload it. CDP navigation events invalidate that old ref set.
    if ("ref" in op && (!tab.snapshot || op.snapshot !== tab.generation || !tab.snapshot.refs.has(op.ref))) {
      throw new OperationError("invalid", "take a new snapshot");
    }
    if (op.op === "snapshot") {
      if (op.page === 1) {
        const documentEpoch = tab.documentEpoch;
        const data = await invoke(op.interactiveOnly ? ["snapshot", "-i"] : ["snapshot"]);
        const captured = z.object({ snapshot: z.string(), refs: z.record(ElementRef, z.object({ role: z.string(), name: z.string().optional() })) }).parse(data);
        if (tab.documentEpoch !== documentEpoch) throw new OperationError("invalid", "take a new snapshot");
        const masked = maskSnapshot(captured.snapshot, captured.refs);
        tab.generation += 1;
        tab.snapshot = { ...masked, interactiveOnly: op.interactiveOnly };
      }
      const snapshot = tab.snapshot;
      if (!snapshot || snapshot.interactiveOnly !== op.interactiveOnly) throw new OperationError("invalid", "take a new snapshot");
      const pages = Math.max(1, Math.ceil(snapshot.text.length / LIMITS.snapshotPageChars));
      if (op.page > pages) throw new OperationError("invalid", "snapshot page is out of range");
      return { ...navigation(tab), snapshot: tab.generation, page: op.page, pages,
        text: snapshot.text.slice((op.page - 1) * LIMITS.snapshotPageChars, op.page * LIMITS.snapshotPageChars) };
    }
    if (op.op === "screenshot") {
      // The page may show what was typed (a code field, a "show password" toggle). Snapshots mask fields; images cannot.
      if (tab.secretEpoch === tab.mainEpoch) {
        throw new OperationError("blocked", "screenshots are off on this page because a saved login was typed into it; use browser_snapshot, or load another page first");
      }
      const path = join(deps.roots.scratch, `screenshot-${request.commandId}.png`);
      try {
        await invoke(["screenshot", path, "--screenshot-format", "png"]);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let png: Buffer;
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Invalid screenshot file");
          png = await file.readFile();
        } finally { await file.close(); }
        const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        if (!png.subarray(0, 8).equals(signature)) throw new Error("Screenshot is not PNG");
        if (png.length > LIMITS.screenshotMaxBytes) {
          const clip = await viewport(tab);
          png = await targetSession(tab, async (session) => {
            for (const scale of [0.75, 0.5, 0.25, 0.125, 0.0625]) {
              const captured = z.object({ data: z.string() }).parse(await deps.cdp.send("Page.captureScreenshot", {
                format: "png", captureBeyondViewport: false, clip: { ...clip, scale },
              }, session));
              const reduced = Buffer.from(captured.data, "base64");
              if (!reduced.subarray(0, 8).equals(signature)) throw new Error("Downscaled screenshot is not PNG");
              if (reduced.length <= LIMITS.screenshotMaxBytes) return reduced;
            }
            throw new Error("PNG screenshot exceeds the size limit after downscaling");
          });
        }
        return { pngBase64: png.toString("base64") };
      } finally { await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    }
    if (op.op === "click" || op.op === "download") {
      const started = downloads.watchBegin(request.commandId, op.op === "download" ? 15_000 : 2_000);
      try {
        await invoke(["click", `@${op.ref}`], undefined, true);
        const item = await started.promise;
        if (!item && op.op === "download") throw new OperationError("failed", "no download started");
        if (item) await downloads.flush();
        // A click can open or close tabs (target=_blank downloads do both); learn which tab is active now.
        await listTabs();
        return item ? { download: { downloadId: item.downloadId, suggestedFilename: item.suggestedFilename } } : {};
      } finally { started.cancel(); }
    }
    switch (op.op) {
      case "activate": break;
      case "close": await invoke(["tab", "close", tab.targetId], undefined, true); tabs.delete(tab.ref); return {};
      case "navigate": delete tab.snapshot; await invoke(["open", safeArgument(op.url)], undefined, true); break;
      case "back": case "forward": case "reload": delete tab.snapshot; await invoke([op.op], undefined, true); break;
      case "type": {
        const documentEpoch = tab.documentEpoch;
        // Inspect real attributes immediately before every input dispatch. Names and snapshot values alone
        // cannot identify empty password fields, localized labels or a field changed since the snapshot.
        const type = z.object({ value: z.string().nullable() }).parse(await invoke(["get", "attr", `@${op.ref}`, "type"])).value;
        const autocomplete = z.object({ value: z.string().nullable() }).parse(await invoke(["get", "attr", `@${op.ref}`, "autocomplete"])).value;
        if (!tab.snapshot || tab.documentEpoch !== documentEpoch || op.snapshot !== tab.generation || !tab.snapshot.refs.has(op.ref)) {
          throw new OperationError("invalid", "take a new snapshot");
        }
        const sensitiveAutocomplete = /(?:one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp)/i;
        if (type?.toLowerCase() === "password" || sensitiveAutocomplete.test(autocomplete ?? "") || tab.snapshot.passwords.has(op.ref)) {
          throw new OperationError("blocked", "password and code fields are typed from saved logins with browser_fill_login and browser_fill_code");
        }
        await invoke([op.mode === "replace" ? "fill" : "type", `@${op.ref}`, safeArgument(op.text)], undefined, true);
        if (op.submit) await invoke(["press", "Enter"], undefined, true);
        return {};
      }
      case "select": await invoke(["select", `@${op.ref}`, safeArgument(op.option)], undefined, true); return {};
      case "check": await invoke([op.checked ? "check" : "uncheck", `@${op.ref}`], undefined, true); return {};
      case "press": await invoke(["press", op.key], undefined, true); return {};
      case "scroll": {
        const size = await viewport(tab);
        const pixels = Math.max(1, Math.round(size.height * (op.amount === "line" ? 0.05 : op.amount === "half" ? 0.5 : 1)));
        await invoke(["scroll", op.direction, String(pixels)]); return {};
      }
      case "wait": await invoke(waitArgv(op), op.timeoutS * 1000 + 1000); return {};
    }
    await listTabs();
    const after = tabs.get(tab.ref);
    if (!after) throw new Error("Tab disappeared after navigation");
    return navigation(after);
  }
  function refusal(request: CommandIdentity): string | undefined {
    if (lease.holder === "owner") return "owner has control";
    if (leaseChanging > 0 || lease.holder === "paused" || request.generation !== lease.generation ||
        (lease.expiresAt !== null && Date.parse(lease.expiresAt) <= deps.clock.now().getTime())) return "paused";
    return undefined;
  }
  function execute(input: unknown): Promise<BrowserCommandResult> {
    const parsed = BrowserCommandRequest.safeParse(input);
    if (!parsed.success) return Promise.resolve({ commandId: "invalid", status: "invalid", message: "invalid browser command" });
    const request = parsed.data;
    return enqueue(request, "command", MUTATING_BROWSER_OPS.has(request.op.op), () => executeOp(request));
  }
  function secretFill(input: unknown): Promise<BrowserCommandResult> {
    const parsed = SecretFillRequest.safeParse(input);
    if (!parsed.success) return Promise.resolve({ commandId: "invalid", status: "invalid", message: "invalid secret fill request" });
    const request = parsed.data;
    return enqueue(request, "secret", true, () => executeSecretFill(request));
  }
  function enqueue(request: CommandIdentity, kind: "command" | "secret", mutating: boolean,
    work: () => Promise<Partial<BrowserCommandResult>>): Promise<BrowserCommandResult> {
    const fingerprint = createHmac("sha256", fingerprintKey).update(kind).update(JSON.stringify(request)).digest("hex");
    // Only this metadata is attached to the running context or retained by the result-cache continuation.
    const identity: CommandIdentity = { commandId: request.commandId, runId: request.runId, generation: request.generation };
    const previous = results.get(identity.commandId) ?? pending.get(identity.commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.resolve({ commandId: identity.commandId, status: "invalid", message: "command id already used" });
      return "result" in previous ? Promise.resolve(previous.result) : previous.promise;
    }
    const command = queue.then(async (): Promise<BrowserCommandResult> => {
      const blocked = refusal(identity);
      if (blocked) return { commandId: identity.commandId, status: "blocked", message: blocked };
      if (stopping || !await refreshReadiness()) return { commandId: identity.commandId, status: "failed", message: "browser not ready" };
      // Readiness includes I/O. A lease update during that await must fence this command too.
      const changed = refusal(identity);
      if (changed) return { commandId: identity.commandId, status: "blocked", message: changed };
      let finish!: () => void;
      const context: Running = { request: identity, secret: kind === "secret", done: new Promise<void>((resolve) => { finish = resolve; }), abort: new AbortController(), tainted: false, dispatched: false };
      running = context;
      try {
        const data = await work();
        if (context.tainted) return { commandId: identity.commandId, status: "outcome_unknown", message: "control lease changed during command" };
        return BrowserCommandResult.parse({ commandId: identity.commandId, status: "ok", ...data });
      } catch (error) {
        // A broken CLI reply during a mutating operation is never evidence that the action did not run.
        // Keep this conservative even if the failure happened while preparing that operation's tab.
        const expected = error instanceof OperationError || error instanceof SecretFillError;
        const unknown = context.tainted || (mutating && !expected);
        const status = unknown ? "outcome_unknown" : expected ? error.status : "failed";
        return { commandId: identity.commandId, status, message: expected || (kind === "command" && error instanceof UncertainProcessError) ? error.message : kind === "secret" ? "secret fill failed" : "browser command failed" };
      } finally { running = undefined; finish(); }
    });
    const stored = command.then((result) => {
      results.set(identity.commandId, { result, fingerprint });
      if (results.size > 500) results.delete(results.keys().next().value!);
      pending.delete(identity.commandId);
      return result;
    });
    pending.set(identity.commandId, { promise: stored, fingerprint });
    queue = stored.then(() => undefined);
    return stored;
  }
  function setControlLease(input: unknown): Promise<ControlLease> {
    const next = ControlLease.parse(input);
    if (next.expiresAt !== null) IsoTime.parse(next.expiresAt);
    leaseChanging += 1;
    const update = leaseQueue.then(async () => {
      if (JSON.stringify(next) === JSON.stringify(lease)) return { ...lease };
      if (next.generation <= lease.generation) throw new OperationError("invalid", "control lease generation must increase");
      const active = running;
      if (active) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          active.done.then(() => false),
          new Promise<boolean>((resolve) => { timer = deps.clock.setTimeout(() => resolve(true), 10_000); }),
        ]);
        if (timer !== undefined) deps.clock.clearTimeout(timer);
        if (timedOut) {
          active.tainted = true;
          ready = false;
          let killedPid: number;
          // Killing only the CLI leaves the daemon free to deliver late page input. Terminate the daemon
          // first, then cancel and join the CLI before publishing the owner's lease.
          try {
            const pidText = (await readFile(join(deps.roots.daemon, "quokkabot.pid"), "utf8")).trim();
            const pid = Number(pidText);
            if (!/^[0-9]+$/.test(pidText) || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
              throw new OperationError("failed", "cannot terminate agent-browser: invalid daemon pid");
            }
            try { process.kill(pid, "SIGKILL"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            killedPid = pid;
            daemonIdentity = undefined;
          } catch (error) {
            if (error instanceof OperationError) throw error;
            throw new OperationError("failed", "cannot terminate agent-browser daemon for control lease change");
          } finally {
            // Secret input uses our CDP connection as well as the daemon. Close it before publishing owner control.
            if (active.secret) deps.cdp.close();
            active.abort.abort();
            await active.done;
          }
          await waitForDaemonExit(killedPid);
        }
      }
      dropRefs();
      lease = next;
      return { ...lease };
    }).finally(() => { leaseChanging -= 1; });
    leaseQueue = update.then(() => undefined, () => undefined);
    return update;
  }
  function launchChrome(): void {
    chromeUp = false;
    ready = false;
    // This service is the only Chrome owner in the sandbox, so a profile lock left by a killed or recreated container is
    // always stale. Left in place, Chrome stops at an "in use on another computer" dialog and never opens DevTools.
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      rmSync(join(CHROME_PROFILE_DIR, name), { force: true });
    }
    cdpConfigured = false;
    dropRefs();
    chrome = deps.runner.start(deps.chrome, launchArgv, { env: processEnv, cwd: deps.roots.scratch });
    chromeUp = true;
    void chrome.exited.catch(() => undefined).finally(() => {
      chromeUp = false; ready = false; cdpConfigured = false; deps.cdp.close();
    });
  }
  async function maintain(): Promise<void> {
    if (stopping) return;
    try {
      if (!chromeUp) launchChrome();
      if (!deps.cdp.connected) await deps.cdp.connect();
      if (!cdpConfigured) {
        await deps.cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: deps.roots.staging, eventsEnabled: true });
        cdpConfigured = true;
      }
      if (!running && pending.size === 0) await refreshReadiness();
    } catch { ready = false; }
    if (!stopping) maintenance = deps.clock.setTimeout(() => { void maintain(); }, 1000);
  }
  async function start(): Promise<void> {
    if (started || stopping) throw new Error("Browser service already started or stopped");
    started = true;
    await maintain();
  }
  async function shutdown(): Promise<void> {
    stopping = true;
    ready = false;
    if (maintenance !== undefined) deps.clock.clearTimeout(maintenance);
    await queue;
    if (chromeUp && chrome) {
      // No signal fallback: Browser.close is necessary to flush cookies before container shutdown.
      if (!deps.cdp.connected) throw new Error("Cannot close Chrome gracefully while CDP is disconnected");
      await deps.cdp.send("Browser.close");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([chrome.exited, new Promise<never>((_resolve, reject) => {
          timer = deps.clock.setTimeout(() => reject(new Error("Chrome did not exit after Browser.close")), 10_000);
        })]);
      } finally { if (timer !== undefined) deps.clock.clearTimeout(timer); }
    }
    await downloads.flush();
    deps.cdp.close();
  }
  function authorized(value: string | undefined): boolean {
    return timingSafeEqual(tokenHash, createHash("sha256").update(value ?? "").digest());
  }
  async function handle(request: ServiceRequest): Promise<ServiceResponse> {
    if (!authorized(request.authorization)) return { statusCode: 401, body: { message: "unauthorized" } };
    const url = new URL(request.path, "http://browser-service");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return { statusCode: 200, body: { chrome: chromeUp ? "up" : "down", cdp: deps.cdp.connected,
          agentBrowserReady: ready && !fault, lease: { ...lease } } };
      }
      if (request.method === "POST" && url.pathname === "/v1/commands") return { statusCode: 200, body: await execute(request.body) };
      if (request.method === "POST" && url.pathname === "/v1/secret-fill") return { statusCode: 200, body: await secretFill(request.body) };
      const commandId = /^\/v1\/commands\/([A-Za-z0-9_-]{8,64})$/.exec(url.pathname)?.[1];
      if (request.method === "GET" && commandId) {
        const result = results.get(commandId)?.result;
        return result ? { statusCode: 200, body: result } : { statusCode: 404, body: { message: "command not found" } };
      }
      if (request.method === "GET" && url.pathname === "/v1/control-lease") return { statusCode: 200, body: { ...lease } };
      if (request.method === "PUT" && url.pathname === "/v1/control-lease") return { statusCode: 200, body: await setControlLease(request.body) };
      if (request.method === "GET" && url.pathname === "/v1/downloads") {
        const since = url.searchParams.get("since");
        if (since !== null) IsoTime.parse(since);
        await downloads.flush();
        return { statusCode: 200, body: { downloads: downloads.list(since ?? undefined) } };
      }
      const downloadPath = /^\/v1\/downloads\/([^/]+)\/(content|ack)$/.exec(url.pathname);
      if (downloadPath) {
        const id = DownloadId.parse(downloadPath[1]);
        if (request.method === "GET" && downloadPath[2] === "content") {
          await downloads.flush();
          const content = await downloads.content(id);
          return { statusCode: 200, headers: { "content-type": "application/octet-stream", "content-length": String(content.size),
            "x-quokkabot-sha256": content.sha256, "x-content-type-options": "nosniff" }, stream: content.stream };
        }
        if (request.method === "POST" && downloadPath[2] === "ack") { await downloads.ack(id); return { statusCode: 200, body: { ok: true } }; }
      }
      if (request.method === "POST" && url.pathname === "/v1/site-data/clear") {
        const body = SiteDataClearRequest.parse(request.body);
        // Serialize clearing with commands so the next action cannot race site-data removal.
        const clear = queue.then(async () => {
          try { return await clearSiteData(deps.cdp, body.patterns); }
          finally { dropRefs(); }
        });
        queue = clear.then(() => undefined, () => undefined);
        return { statusCode: 200, body: await clear };
      }
      if (request.method === "POST" && url.pathname === "/v1/shutdown") { await shutdown(); return { statusCode: 200, body: { ok: true } }; }
      return { statusCode: 404, body: { message: "not found" } };
    } catch (error) {
      if (error instanceof SiteDataClearError) return { statusCode: 500, body: { message: error.message } };
      if (error instanceof z.ZodError) return { statusCode: 400, body: { message: "invalid request" } };
      if (error instanceof DownloadError || error instanceof OperationError) return { statusCode: 409, body: { message: error.message } };
      return { statusCode: 409, body: { message: "browser service operation refused" } };
    }
  }
  async function http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!authorized(request.headers.authorization)) { response.writeHead(401).end(); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > 1024 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(chunk as Buffer);
      }
      let body: unknown;
      try { body = size === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { response.writeHead(400).end(); return; }
      const result = await handle({ method: request.method ?? "", path: request.url ?? "/", authorization: request.headers.authorization!, body });
      response.writeHead(result.statusCode, result.headers ?? { "content-type": "application/json" });
      if (result.stream) await pipeline(result.stream, response);
      else response.end(JSON.stringify(result.body));
    } catch { if (!response.headersSent) response.writeHead(500).end(); else response.destroy(); }
  }
  const server = createServer((request, response) => { void http(request, response); });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  return { server, start, shutdown, execute, handle, setControlLease, refreshReadiness, downloads };
}
export type BrowserService = Awaited<ReturnType<typeof createBrowserService>>;

// A short, value-free name for an agent-browser error, so the agent can react to it.
export function errorKind(error: string): string {
  const kinds: [RegExp, string][] = [
    [/^Element not found/i, "element not found; take a new snapshot"],
    [/denied by policy/i, "action not allowed"],
    [/timed? ?out/i, "timed out"],
    [/covered|intercept|obscured/i, "element is covered by another element"],
    [/not visible|hidden/i, "element is not visible"],
    [/net::ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/i, "site blocked by the egress policy"],
    [/net::ERR_/i, "network error"],
  ];
  for (const [pattern, name] of kinds) if (pattern.test(error)) return `: ${name}`;
  return "";
}
