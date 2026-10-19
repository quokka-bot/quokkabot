import { BrowserWindow, screen, session } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SettingsStore } from "./settings.js";
import type { DesktopServer } from "./server.js";
import { secureContents } from "./security.js";
import { IPC } from "./schemas.js";
import { routeAllowed } from "./policy.js";

export class DesktopWindows {
  main: BrowserWindow | null = null;
  connect: BrowserWindow | null = null;
  readonly connectUrl: string;
  private server: DesktopServer | null = null;
  private viewOrigin: string | null = null;
  private pendingRoute: string | null = null;
  private savingBounds: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly directory: string, private readonly settings: SettingsStore, private readonly development: boolean, private readonly external: (url: string) => Promise<void>, private readonly report: (error: unknown) => void) {
    this.connectUrl = pathToFileURL(join(directory, "connect.html")).href;
  }

  configure(server: DesktopServer, viewOrigin: string): void { this.server = server; this.viewOrigin = viewOrigin; }

  show(): void {
    if (this.server === null || this.viewOrigin === null) { this.showConnect(); return; }
    if (this.main !== null) { if (this.main.isMinimized()) this.main.restore(); this.main.show(); this.main.focus(); return; }
    const saved = this.settings.get().bounds;
    const visible = screen.getAllDisplays().some(({ workArea }) => saved.x !== undefined && saved.y !== undefined && saved.x + 100 > workArea.x && saved.y + 100 > workArea.y && saved.x < workArea.x + workArea.width - 100 && saved.y < workArea.y + workArea.height - 100);
    const window = new BrowserWindow({
      width: saved.width, height: saved.height, ...(visible && saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}), minWidth: 900, minHeight: 600,
      title: "Quokka Bot", show: false, backgroundColor: "#fcfcfc", ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 16 } } : {}),
      icon: join(this.directory, "../build/icon.png"),
      webPreferences: { session: this.server.session, preload: join(this.directory, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: this.development },
    });
    this.main = window;
    secureContents(window.webContents, { serverOrigin: this.server.origin, viewOrigin: this.viewOrigin }, this.external, this.report);
    window.on("ready-to-show", () => window.show());
    window.webContents.on("did-finish-load", () => { this.deliverRoute(); });
    window.on("close", (event) => {
      event.preventDefault();
      this.saveBounds(window);
      // Closing destroys the renderer even if the page tries to keep its terminal or takeover stream alive.
      window.destroy();
    });
    window.on("closed", () => {
      if (this.savingBounds !== null) { clearTimeout(this.savingBounds); this.savingBounds = null; }
      if (this.main === window) this.main = null;
    });
    window.on("resize", () => this.scheduleBounds(window));
    window.on("move", () => this.scheduleBounds(window));
    void window.loadURL(this.server.origin).catch(this.report);
    this.connect?.destroy();
  }

  private scheduleBounds(window: BrowserWindow): void {
    if (this.savingBounds !== null) clearTimeout(this.savingBounds);
    this.savingBounds = setTimeout(() => { this.savingBounds = null; this.saveBounds(window); }, 350);
  }
  private saveBounds(window: BrowserWindow): void {
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized() || window.isFullScreen()) return;
    void this.settings.update({ bounds: window.getBounds() }).catch(this.report);
  }

  showConnect(): void {
    if (this.connect !== null) { this.connect.show(); this.connect.focus(); return; }
    const isolated = session.fromPartition("quokkabot-connect");
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const allowed = ["connect.html", "connect.js", "connect.css"].map((name) => pathToFileURL(join(this.directory, name)).href);
      callback({ cancel: !allowed.includes(details.url) });
    });
    const window = new BrowserWindow({
      width: 480, height: 460, resizable: false, title: "Connect to Quokka Bot", show: false, backgroundColor: "#fcfcfc",
      webPreferences: { session: isolated, preload: join(this.directory, "connect-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: this.development },
    });
    this.connect = window;
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-frame-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.on("ready-to-show", () => window.show());
    window.on("closed", () => { if (this.connect === window) this.connect = null; });
    void window.loadURL(this.connectUrl).catch(this.report);
  }

  navigate(route: string): void {
    if (!routeAllowed(route)) throw new Error(`Refused desktop route: ${route}`);
    this.pendingRoute = route;
    this.show();
    this.deliverRoute();
  }
  private deliverRoute(): void {
    if (this.pendingRoute === null || this.main === null || this.main.webContents.isLoadingMainFrame()) return;
    this.main.webContents.send(IPC.navigate, this.pendingRoute);
    this.pendingRoute = null;
  }

  reloadAfterSignIn(): Promise<void> {
    this.show();
    const window = this.main;
    if (window === null || this.server === null) throw new Error("The app window is unavailable.");
    return window.loadURL(this.server.origin);
  }

  reset(): void {
    this.server = null; this.viewOrigin = null; this.pendingRoute = null;
    this.main?.destroy();
    this.showConnect();
  }
}
