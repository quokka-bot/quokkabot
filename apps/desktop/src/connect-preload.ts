import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "./channels.js";

contextBridge.exposeInMainWorld("quokkabotConnect", Object.freeze({
  connect: (origin: string): Promise<void> => ipcRenderer.invoke(IPC.connect, origin),
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.connectVersion),
}));
