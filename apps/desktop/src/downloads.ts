import { Notification, shell } from "electron";
import type { DownloadItem, Event, WebContents } from "electron";
import { createWriteStream, mkdirSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DesktopDownloadTarget } from "@quokkabot/shared";
import { contentFilename, downloadApiPath } from "./download-policy.js";
import { reserveDownload } from "./download-storage.js";
import { safeOrigin } from "./policy.js";
import type { DesktopServer } from "./server.js";
import { responseError } from "./server.js";

async function* downloadChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally { reader.releaseLock(); }
}

export class DesktopDownloads {
  private readonly items = new Set<DownloadItem>();
  private readonly requests = new Set<AbortController>();
  private readonly notifications = new Set<Notification>();
  private readonly listener: (event: Event, item: DownloadItem, contents: WebContents) => void;
  private stopped = false;

  constructor(private readonly server: DesktopServer, private readonly directory: () => string, private readonly getMainContents: () => WebContents | null, private readonly report: (error: unknown) => void) {
    this.listener = (event, item, contents) => {
      if (this.stopped || contents !== this.getMainContents() || safeOrigin(item.getURL()) !== this.server.origin || item.getURLChain().some((url) => safeOrigin(url) !== this.server.origin)) {
        event.preventDefault(); item.cancel(); return;
      }
      let reservedPath: string | null = null;
      try {
        const saved = reserveDownload(this.directory(), item.getFilename());
        reservedPath = saved.path;
        item.setSavePath(saved.path);
        this.items.add(item);
        item.once("done", (_event, state) => {
          this.items.delete(item);
          if (state === "completed") {
            void stat(saved.path).then(() => { if (!this.stopped) this.saved(saved.path, saved.name); }).catch(this.report);
          } else {
            void rm(saved.path, { force: true }).catch(this.report);
            if (!this.stopped) this.report(new Error(`Download ${saved.name} ${state}.`));
          }
        });
      } catch (error) {
        event.preventDefault(); item.cancel();
        if (reservedPath !== null) void rm(reservedPath, { force: true }).catch(this.report);
        this.report(error);
      }
    };
    server.session.on("will-download", this.listener);
  }

  async download(target: DesktopDownloadTarget): Promise<{ name: string }> {
    if (this.stopped) throw new Error("The download session has closed.");
    const controller = new AbortController();
    this.requests.add(controller);
    let reserved: { path: string; name: string } | null = null;
    try {
      const response = await this.server.sessionFetch(downloadApiPath(target), { signal: controller.signal }, 10 * 60 * 1000);
      if (!response.ok) throw await responseError(response);
      if (response.body === null) throw new Error("The server returned no download body.");
      const fallback = "path" in target ? basename(target.path) : "download";
      reserved = reserveDownload(this.directory(), contentFilename(response.headers.get("content-disposition"), fallback));
      await pipeline(downloadChunks(response.body), createWriteStream(reserved.path, { flags: "r+", mode: 0o600 }), { signal: controller.signal });
      const file = await stat(reserved.path);
      const length = response.headers.get("content-length");
      if (length !== null && !response.headers.has("content-encoding") && file.size !== Number(length)) throw new Error("The saved download size does not match the server's Content-Length.");
      this.saved(reserved.path, reserved.name);
      return { name: reserved.name };
    } catch (error) {
      if (reserved !== null) await rm(reserved.path, { force: true });
      throw error;
    } finally { this.requests.delete(controller); }
  }

  async showDownloads(): Promise<void> {
    mkdirSync(this.directory(), { recursive: true, mode: 0o700 });
    const error = await shell.openPath(this.directory());
    if (error) throw new Error(error);
  }

  private saved(path: string, name: string): void {
    if (this.stopped) return;
    const notification = new Notification({ title: `Saved ${name}`, body: "Show in Finder", actions: [{ type: "button", text: "Show in Finder" }] });
    const reveal = (): void => shell.showItemInFolder(path);
    notification.on("click", reveal);
    notification.on("action", reveal);
    notification.on("close", () => this.notifications.delete(notification));
    this.notifications.add(notification);
    notification.show();
  }

  dispose(): void {
    this.stopped = true;
    this.server.session.removeListener("will-download", this.listener);
    for (const request of this.requests) request.abort();
    for (const item of this.items) item.cancel();
    for (const notification of this.notifications) notification.close();
    this.notifications.clear();
  }
}
