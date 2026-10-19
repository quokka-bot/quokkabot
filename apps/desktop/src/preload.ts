import { contextBridge, ipcRenderer } from "electron";
import type { QuokkaBotDesktopBridge } from "@quokkabot/shared";
import { IPC } from "./channels.js";

const subscribers = new Set<(route: string) => void>();
let pendingRoute: string | null = null;
ipcRenderer.on(IPC.navigate, (_event, route: unknown) => {
  if (typeof route !== "string") return;
  if (subscribers.size === 0) { pendingRoute = route; return; }
  for (const callback of subscribers) callback(route);
});

const platform = process.platform;
if (platform !== "darwin" && platform !== "win32" && platform !== "linux") throw new Error("Unsupported desktop platform.");
const bridge: QuokkaBotDesktopBridge = {
  platform, appVersion: __QUOKKABOT_APP_VERSION__,
  startSignIn: () => ipcRenderer.invoke(IPC.startSignIn), startFreshCheck: () => ipcRenderer.invoke(IPC.startFreshCheck),
  waitForFlow: () => ipcRenderer.invoke(IPC.waitForFlow), cancelFlow: () => ipcRenderer.invoke(IPC.cancelFlow),
  download: (target) => ipcRenderer.invoke(IPC.download, target), showDownloads: () => ipcRenderer.invoke(IPC.showDownloads),
  onNavigate: (callback) => {
    if (typeof callback !== "function") throw new Error("onNavigate requires a callback.");
    subscribers.add(callback);
    if (pendingRoute !== null) { const route = pendingRoute; pendingRoute = null; callback(route); }
    return () => { subscribers.delete(callback); };
  },
  getSettings: () => ipcRenderer.invoke(IPC.getSettings), setSettings: (settings) => ipcRenderer.invoke(IPC.setSettings, settings),
  getUpdateStatus: () => ipcRenderer.invoke(IPC.getUpdateStatus), installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
  changeServer: () => ipcRenderer.invoke(IPC.changeServer),
};
contextBridge.exposeInMainWorld("quokkabotDesktop", Object.freeze(bridge));
