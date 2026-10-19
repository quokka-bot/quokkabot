import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DownloadInfo, LIMITS } from "@quokkabot/shared";
import type { BrowserCommandRequest } from "@quokkabot/shared";
import type { CdpConnection } from "./cdp.js";
import type { Clock } from "./runtime.js";

const BeginEvent = z.object({ guid: DownloadInfo.shape.guid, suggestedFilename: z.string().max(255), url: z.string().max(4096) });
const ProgressEvent = z.object({
  guid: DownloadInfo.shape.guid, state: z.enum(["inProgress", "completed", "canceled"]),
  receivedBytes: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
});
interface Watcher { commandId: string; resolve(value: DownloadInfo | undefined): void }
export class DownloadError extends Error {}
export class Downloads {
  private byGuid = new Map<string, DownloadInfo>();
  private watchers = new Set<Watcher>();
  private writes: Promise<void> = Promise.resolve();
  private fault: Error | undefined;
  constructor(private readonly root: string, private readonly clock: Clock, private readonly cdp: CdpConnection) {}
  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Download staging root must be a real directory");
    let handle;
    try { handle = await open(join(this.root, ".state.json"), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Invalid download state file");
      const state = z.array(DownloadInfo).parse(JSON.parse(await handle.readFile("utf8")));
      const ids = new Set<string>();
      for (const item of state) {
        if (this.byGuid.has(item.guid) || ids.has(item.downloadId)) throw new Error("Duplicate download state identity");
        this.byGuid.set(item.guid, item);
        ids.add(item.downloadId);
      }
    } finally { await handle.close(); }
  }
  assertHealthy(): void { if (this.fault) throw this.fault; }
  async flush(): Promise<void> { await this.writes; this.assertHealthy(); }
  private persist(): Promise<void> {
    const bytes = JSON.stringify([...this.byGuid.values()]);
    this.writes = this.writes.then(async () => {
      this.assertHealthy();
      const temporary = join(this.root, `.state-${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, join(this.root, ".state.json"));
      const directory = await open(this.root, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }).catch(() => { this.fault = new DownloadError("Download state persistence failed"); });
    return this.writes;
  }
  async event(method: string, params: unknown, running: Pick<BrowserCommandRequest, "commandId" | "runId"> | undefined): Promise<void> {
    this.assertHealthy();
    if (method === "Browser.downloadWillBegin") {
      const event = BeginEvent.parse(params);
      if (this.byGuid.has(event.guid)) return;
      const item: DownloadInfo = {
        downloadId: DownloadInfo.shape.downloadId.parse(randomUUID()), guid: event.guid, state: "in_progress",
        suggestedFilename: event.suggestedFilename, url: event.url, receivedBytes: 0, totalBytes: null,
        startedAt: this.clock.now().toISOString(), endedAt: null,
        commandId: running?.commandId ?? null, runId: running?.runId ?? null,
      };
      this.byGuid.set(item.guid, item);
      const persistence = this.persist();
      // The deadline measures the CDP begin event, not disk latency. Commands flush persistence before
      // returning the handle so control cannot observe a download that would disappear on a restart.
      for (const watcher of this.watchers) if (watcher.commandId === item.commandId) watcher.resolve(item);
      await persistence;
      this.assertHealthy();
    } else if (method === "Browser.downloadProgress") {
      const event = ProgressEvent.parse(params);
      const item = this.byGuid.get(event.guid);
      // Events for an acknowledged GUID or a pre-service download cannot create a downloadable file.
      if (!item || item.state !== "in_progress") return;
      if (event.receivedBytes < item.receivedBytes) throw new Error("Download byte count moved backwards");
      item.receivedBytes = event.receivedBytes;
      item.totalBytes = event.totalBytes === 0 && event.state !== "completed" ? null : event.totalBytes;
      if (event.state === "completed") { item.state = "completed"; item.totalBytes = event.receivedBytes; }
      if (event.state === "canceled") item.state = "cancelled";
      if (event.receivedBytes > LIMITS.downloadMaxBytes || event.totalBytes > LIMITS.downloadMaxBytes) {
        item.state = "failed";
        await this.cdp.send("Browser.cancelDownload", { guid: item.guid });
      }
      if (item.state !== "in_progress") item.endedAt = this.clock.now().toISOString();
      await this.persist();
      this.assertHealthy();
    }
  }
  watchBegin(commandId: string, timeoutMs: number): { promise: Promise<DownloadInfo | undefined>; cancel(): void } {
    let timer: ReturnType<typeof setTimeout>;
    let watcher: Watcher;
    const promise = new Promise<DownloadInfo | undefined>((resolve) => {
      watcher = { commandId, resolve: (item) => { this.clock.clearTimeout(timer); this.watchers.delete(watcher); resolve(item); } };
      this.watchers.add(watcher);
      timer = this.clock.setTimeout(() => watcher.resolve(undefined), timeoutMs);
    });
    return { promise, cancel: () => watcher.resolve(undefined) };
  }
  list(since?: string): DownloadInfo[] {
    this.assertHealthy();
    const time = since === undefined ? -Infinity : Date.parse(since);
    if (Number.isNaN(time)) throw new DownloadError("since must be an ISO timestamp");
    // A long-running download must remain discoverable when it completes after a previous poll.
    return [...this.byGuid.values()].filter((item) => item.state === "in_progress" ||
      Date.parse(item.endedAt ?? item.startedAt) >= time).map((item) => ({ ...item }));
  }
  get(id: string): DownloadInfo {
    this.assertHealthy();
    const item = [...this.byGuid.values()].find((entry) => entry.downloadId === id);
    if (!item) throw new DownloadError("Download not found");
    return item;
  }
  async content(id: string) {
    const item = this.get(id);
    if (item.state !== "completed") throw new DownloadError("Download is not completed");
    const handle = await open(join(this.root, item.guid), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(() => { throw new DownloadError("Download content could not be opened safely"); });
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== item.receivedBytes || stat.size > LIMITS.downloadMaxBytes) {
        throw new DownloadError("Download content is not a regular file of the recorded size");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (bytesRead === 0) throw new DownloadError("Download content changed while hashing");
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new DownloadError("Download content changed while hashing");
      // Reuse this descriptor, never reopen a pathname after validation.
      return { size: stat.size, sha256: hash.digest("hex"), stream: handle.createReadStream({ start: 0, autoClose: true }) };
    } catch (error) { await handle.close(); throw error; }
  }
  async ack(id: string): Promise<void> {
    const item = this.get(id);
    if (item.state !== "completed") throw new DownloadError("Only completed downloads may be acknowledged");
    try { await unlink(join(this.root, item.guid)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.byGuid.delete(item.guid);
    await this.persist();
    this.assertHealthy();
  }
}
