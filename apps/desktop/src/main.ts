import { app, dialog, Notification, session, shell } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { AgentSummary, KillAllResult } from "@quokkabot/shared";
import type { DesktopSettings } from "@quokkabot/shared";
import { DesktopAuth } from "./auth.js";
import { DesktopDownloads } from "./downloads.js";
import { registerIpc } from "./ipc.js";
import { installMenu } from "./menu.js";
import { DesktopNotifications } from "./notifications.js";
import { partitionForOrigin, validateOrigin } from "./origins.js";
import { isExternalHttps } from "./policy.js";
import { checkConnectSender, checkMainSender, secureSession } from "./security.js";
import { DesktopServer } from "./server.js";
import { publicSettings, SettingsStore } from "./settings.js";
import { DesktopTray } from "./tray.js";
import { DesktopUpdates } from "./updates.js";
import { DesktopWindows } from "./windows.js";

interface Runtime {
  server: DesktopServer; viewOrigin: string; auth: DesktopAuth;
  downloads: DesktopDownloads; notifications: DesktopNotifications; updates: DesktopUpdates;
}

const testState = { openedExternal: [] as string[], hasTray: (): boolean => false };
if (__QUOKKABOT_E2E__) {
  if (!process.env["QUOKKABOT_E2E_USER_DATA"]) throw new Error("The Electron test build requires an isolated userData directory.");
  app.setPath("userData", process.env["QUOKKABOT_E2E_USER_DATA"]);
  Object.assign(globalThis, { __quokkabotE2E: testState });
}

function report(error: unknown): void { console.error(error instanceof Error ? error.message : String(error)); }
async function openBrowser(url: string): Promise<void> {
  if (__QUOKKABOT_E2E__) { testState.openedExternal.push(url); return; }
  await shell.openExternal(url);
}
async function openExternal(url: string): Promise<void> {
  if (!isExternalHttps(url)) throw new Error("Only HTTPS links can open in the default browser.");
  await openBrowser(url);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("certificate-error", (event, _contents, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
  // A closed window is not a quit: main keeps the tray, kill switch and background polls alive.
  app.on("window-all-closed", () => undefined);
  void app.whenReady().then(start).catch((error: unknown) => {
    report(error);
    dialog.showErrorBox("Quokka Bot could not start", error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
}

async function start(): Promise<void> {
  const settings = await SettingsStore.load(join(app.getPath("userData"), "settings.json"), join(app.getPath("downloads"), "Quokka Bot"));
  const development = !app.isPackaged || !__QUOKKABOT_RELEASE__;
  const windows = new DesktopWindows(__dirname, settings, development, openExternal, report);
  let runtime: Runtime | null = null;
  let changingServer = false;
  let connecting = false;
  const nativeNotices = new Set<Notification>();
  function notify(title: string, body: string): void {
    const notice = new Notification({ title, body: body.slice(0, 600) });
    nativeNotices.add(notice);
    notice.on("close", () => nativeNotices.delete(notice));
    notice.show();
  }
  function actionError(error: unknown): void { report(error); notify("Quokka Bot", error instanceof Error ? error.message : String(error)); }
  function current(): Runtime { if (runtime === null || changingServer) throw new Error("Connect to a Quokka Bot server first."); return runtime; }
  function run(action: () => Promise<unknown>): void { void Promise.resolve().then(action).catch(actionError); }

  async function stopEverything(): Promise<void> {
    try {
      const result = KillAllResult.parse(await current().server.json("/api/agents/kill-all", { method: "POST", body: "{}" }));
      const confirmed = result.confirmed && result.agents.every((agent) => agent.egressFrozen && agent.sandboxesStopped && agent.error === null);
      if (confirmed) notify("Stopped", "Every agent's network is frozen and its sandboxes are stopped.");
      else notify("Stop not confirmed", result.agents.filter((agent) => !agent.egressFrozen || !agent.sandboxesStopped || agent.error !== null).map((agent) => `${agent.agentId}: ${agent.error ?? "Network freeze or sandbox stop not confirmed."}`).join("\n") || "The server could not confirm that every agent stopped.");
    } catch (error) { report(error); notify("Stop not confirmed", error instanceof Error ? error.message : String(error)); }
  }

  const tray = new DesktopTray(__dirname, () => windows.show(), () => { void stopEverything(); }, () => run(() => current().downloads.showDownloads()));
  if (__QUOKKABOT_E2E__) testState.hasTray = () => !tray.tray.isDestroyed();

  function disposeRuntime(): Runtime | null {
    const previous = runtime;
    runtime = null;
    if (previous !== null) {
      previous.auth.cancelFlow(); previous.notifications.dispose(); previous.downloads.dispose(); previous.updates.dispose();
    }
    tray.status(false, null);
    return previous;
  }

  function configure(server: DesktopServer, viewOrigin: string): void {
    disposeRuntime();
    windows.configure(server, viewOrigin);
    secureSession(server.session, { serverOrigin: server.origin, viewOrigin }, () => windows.main);
    const notifications = new DesktopNotifications(server, settings, (route) => windows.navigate(route), (connected, waiting) => tray.status(connected, waiting), report);
    const auth = new DesktopAuth(server, openBrowser, async () => { notifications.refresh(); await windows.reloadAfterSignIn(); }, report);
    const downloads = new DesktopDownloads(server, () => settings.get().downloadDir, () => windows.main?.webContents ?? null, actionError);
    const updates = new DesktopUpdates(server.origin, app.isPackaged && __QUOKKABOT_RELEASE__ && process.platform === "darwin", report);
    runtime = { server, viewOrigin, auth, downloads, notifications, updates };
    windows.show();
    notifications.start(); updates.start();
  }

  async function changeServer(): Promise<void> {
    if (changingServer || connecting) throw new Error("The server configuration is already changing.");
    changingServer = true;
    const previous = disposeRuntime();
    windows.main?.destroy();
    try {
      if (previous !== null) {
        try { await previous.server.json("/api/auth/logout", { method: "POST", body: "{}" }); }
        catch (error) { report(new Error(`Server sign-out was unavailable; clearing this device's local session: ${String(error)}`)); }
        await previous.server.session.clearStorageData();
        await previous.server.session.clearCache();
        await previous.server.session.clearAuthCache();
        await previous.server.session.closeAllConnections();
      }
      await settings.update({ serverOrigin: null, viewOrigin: null, seenNotificationIds: [], activityCursor: null });
      windows.reset();
    } finally { changingServer = false; }
  }

  async function connect(input: string): Promise<void> {
    if (connecting || changingServer) throw new Error("A connection is already in progress.");
    connecting = true;
    try {
      const origin = validateOrigin(input);
      const server = new DesktopServer(origin, session.fromPartition(partitionForOrigin(origin)));
      const info = await server.info(app.getVersion());
      await settings.update({ serverOrigin: origin, viewOrigin: info.viewOrigin, seenNotificationIds: [], activityCursor: null });
      configure(server, info.viewOrigin);
    } finally { connecting = false; }
  }

  async function startFlow(kind: "signin" | "fresh") {
    const selected = current();
    // Re-check after a server upgrade as well as on first connect. Keep the kill switch usable even
    // when a newer minimum version prevents sign-in, or the info endpoint cannot be reached.
    const info = await selected.server.info(app.getVersion());
    if (runtime !== selected || changingServer) throw new Error("The server changed while starting authentication.");
    if (info.viewOrigin !== selected.viewOrigin) throw new Error("The server's viewer origin changed. Use Change server to reconnect.");
    return kind === "signin" ? selected.auth.startSignIn() : selected.auth.startFreshCheck();
  }

  function inApplications(): boolean { return app.isPackaged && /^\/Applications\/.*\.app\//u.test(app.getPath("exe")); }
  async function setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
    if (patch.launchAtLogin === true && !inApplications()) throw new Error("Move Quokka Bot to /Applications before enabling launch at login.");
    const previous = settings.get();
    if (patch.launchAtLogin !== undefined && inApplications()) app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    try { return publicSettings(await settings.update(patch)); }
    catch (error) { if (patch.launchAtLogin !== undefined && inApplications()) app.setLoginItemSettings({ openAtLogin: previous.launchAtLogin }); throw error; }
  }
  if (inApplications()) app.setLoginItemSettings({ openAtLogin: settings.get().launchAtLogin });
  else if (settings.get().launchAtLogin) await settings.update({ launchAtLogin: false });

  registerIpc({
    checkMain: (event) => checkMainSender(event, windows.main, { serverOrigin: current().server.origin, viewOrigin: current().viewOrigin }),
    checkConnect: (event) => checkConnectSender(event, windows.connect, windows.connectUrl),
    startSignIn: () => startFlow("signin"), startFreshCheck: () => startFlow("fresh"), waitForFlow: () => current().auth.waitForFlow(), cancelFlow: () => current().auth.cancelFlow(),
    download: (target) => current().downloads.download(target), showDownloads: () => current().downloads.showDownloads(),
    getSettings: () => publicSettings(settings.get()), setSettings,
    getUpdateStatus: () => current().updates.getStatus(), installUpdate: () => current().updates.install(), changeServer, connect, version: app.getVersion(),
  });

  installMenu({
    navigate: (route) => windows.navigate(route), show: () => windows.show(), stop: () => { void stopEverything(); },
    changeServer: () => run(changeServer), development,
    help: () => run(() => openExternal(new URL("/", current().server.origin).href)),
    agent: (section) => run(async () => {
      const selected = /^\/agents\/([0-9a-f-]{36})/u.exec(new URL(windows.main?.webContents.getURL() ?? current().server.origin).pathname)?.[1];
      const agents = z.object({ agents: z.array(AgentSummary) }).parse(await current().server.json("/api/agents"));
      const agent = agents.agents.find((candidate) => candidate.id === selected) ?? agents.agents[0];
      if (agent === undefined) throw new Error("This server has no agents.");
      windows.navigate(`/agents/${agent.id}/${section}`);
    }),
  });
  app.on("activate", () => windows.show());
  app.on("second-instance", () => windows.show());
  const saved = settings.get();
  if (saved.serverOrigin !== null && saved.viewOrigin !== null) configure(new DesktopServer(saved.serverOrigin, session.fromPartition(partitionForOrigin(saved.serverOrigin))), saved.viewOrigin);
  else windows.showConnect();

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    disposeRuntime(); tray.dispose();
    for (const notice of nativeNotices) notice.close();
    windows.main?.close(); windows.connect?.destroy();
    void settings.flush().then(() => app.quit()).catch((error: unknown) => { report(error); app.exit(1); });
  });
}
