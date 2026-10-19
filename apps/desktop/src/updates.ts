import { autoUpdater, CancellationToken } from "electron-updater";
import type { DesktopUpdateStatus } from "@quokkabot/shared";
import { safeOrigin } from "./policy.js";
import { updateFeed, validateUpdateFiles } from "./update-policy.js";

// electron-updater is one object per app: a check started for the previous server can still be running after a server
// change, and the updater hands that same promise to the next caller. Every check waits for the one before it.
let previousCheck: Promise<unknown> = Promise.resolve();

export class DesktopUpdates {
  private status: DesktopUpdateStatus;
  private timer: ReturnType<typeof setInterval> | null = null;
  private token = new CancellationToken();
  private stopped = false;
  private checking = false;
  private readonly onError = (error: Error): void => {
    if (!this.stopped) { this.status = { state: "error", version: null, message: error.message }; this.report(error); }
  };
  private readonly onProgress = (): void => { if (!this.stopped) this.status = { ...this.status, state: "downloading" }; };
  private readonly onReady = (): void => { if (!this.stopped) this.status = { ...this.status, state: "ready", message: "Ready to install when you choose." }; };

  constructor(private readonly origin: string, private readonly enabled: boolean, private readonly report: (error: unknown) => void) {
    this.status = { state: enabled ? "idle" : "unsupported", version: null, message: enabled ? null : "Updates are available in signed macOS release builds." };
  }

  start(): void {
    if (!this.enabled) return;
    // The updater's own progress lines go to the main process log.
    autoUpdater.logger = { info: (message: unknown) => console.log("[updater]", message), warn: (message: unknown) => console.warn("[updater]", message), error: (message: unknown) => console.error("[updater]", message), debug: () => undefined };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    // This also fences redirects made by the updater's Chromium network session.
    autoUpdater.netSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: this.stopped || safeOrigin(details.url) !== this.origin }));
    autoUpdater.on("error", this.onError);
    autoUpdater.on("download-progress", this.onProgress);
    autoUpdater.on("update-downloaded", this.onReady);
    void this.check();
    this.timer = setInterval(() => { void this.check(); }, 6 * 60 * 60 * 1000);
  }

  private async check(): Promise<void> {
    if (this.stopped || this.checking || this.status.state === "ready") return;
    this.checking = true;
    this.status = { state: "checking", version: null, message: null };
    let done!: () => void;
    const before = previousCheck;
    previousCheck = new Promise<void>((resolve) => { done = resolve; });
    try {
      await before.catch(() => undefined);
      if (this.stopped) return;
      autoUpdater.setFeedURL({ provider: "generic", url: updateFeed(this.origin) });
      const result = await autoUpdater.checkForUpdates();
      if (this.stopped) return;
      if (result === null) throw new Error("The packaged updater is unavailable.");
      if (!result.isUpdateAvailable) { this.status = { state: "idle", version: null, message: null }; return; }
      validateUpdateFiles(result.updateInfo, this.origin);
      this.status = { state: "available", version: result.updateInfo.version, message: null };
      this.token = new CancellationToken();
      this.status = { ...this.status, state: "downloading" };
      await autoUpdater.downloadUpdate(this.token);
      // Squirrel.Mac validates the Developer ID against the installed app during the owner-requested install.
    } catch (error) {
      if (!this.stopped) this.onError(error instanceof Error ? error : new Error(String(error)));
    } finally { this.checking = false; done(); }
  }

  getStatus(): DesktopUpdateStatus { return { ...this.status }; }
  install(): void {
    if (this.stopped || this.status.state !== "ready") throw new Error("No downloaded update is ready to install.");
    autoUpdater.quitAndInstall(false, true);
  }
  dispose(): void {
    this.stopped = true;
    this.token.cancel();
    if (this.timer !== null) clearInterval(this.timer);
    if (!this.enabled) return;
    autoUpdater.removeListener("error", this.onError);
    autoUpdater.removeListener("download-progress", this.onProgress);
    autoUpdater.removeListener("update-downloaded", this.onReady);
  }
}
