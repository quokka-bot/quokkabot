import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import type { DesktopFlowStarted, DesktopFlowResult, DesktopSettings, DesktopDownloadTarget, DesktopUpdateStatus } from "@quokkabot/shared";
import { ConnectPayload, DownloadTarget, IPC, NoPayload, SettingsPatch } from "./schemas.js";

export interface IpcActions {
  checkMain: (event: IpcMainInvokeEvent) => void;
  checkConnect: (event: IpcMainInvokeEvent) => void;
  startSignIn: () => Promise<DesktopFlowStarted>;
  startFreshCheck: () => Promise<DesktopFlowStarted>;
  waitForFlow: () => Promise<DesktopFlowResult>;
  cancelFlow: () => void;
  download: (target: DesktopDownloadTarget) => Promise<{ name: string }>;
  showDownloads: () => Promise<void>;
  getSettings: () => DesktopSettings;
  setSettings: (patch: Partial<DesktopSettings>) => Promise<DesktopSettings>;
  getUpdateStatus: () => DesktopUpdateStatus;
  installUpdate: () => void;
  changeServer: () => Promise<void>;
  connect: (origin: string) => Promise<void>;
  version: string;
}

export function registerIpc(actions: IpcActions): () => void {
  const channels: string[] = [];
  function handle<T>(channel: string, schema: z.ZodType<T>, check: (event: IpcMainInvokeEvent) => void, action: (payload: T) => unknown): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      check(event);
      if (args.length > 1) throw new Error("A desktop IPC method accepts at most one payload.");
      return action(schema.parse(args[0]));
    });
    channels.push(channel);
  }
  handle(IPC.startSignIn, NoPayload, actions.checkMain, actions.startSignIn);
  handle(IPC.startFreshCheck, NoPayload, actions.checkMain, actions.startFreshCheck);
  handle(IPC.waitForFlow, NoPayload, actions.checkMain, actions.waitForFlow);
  handle(IPC.cancelFlow, NoPayload, actions.checkMain, actions.cancelFlow);
  handle(IPC.download, DownloadTarget, actions.checkMain, actions.download);
  handle(IPC.showDownloads, NoPayload, actions.checkMain, actions.showDownloads);
  handle(IPC.getSettings, NoPayload, actions.checkMain, actions.getSettings);
  handle(IPC.setSettings, SettingsPatch, actions.checkMain, actions.setSettings);
  handle(IPC.getUpdateStatus, NoPayload, actions.checkMain, actions.getUpdateStatus);
  handle(IPC.installUpdate, NoPayload, actions.checkMain, actions.installUpdate);
  handle(IPC.changeServer, NoPayload, actions.checkMain, actions.changeServer);
  handle(IPC.connect, ConnectPayload, actions.checkConnect, actions.connect);
  handle(IPC.connectVersion, NoPayload, actions.checkConnect, () => actions.version);
  return () => { for (const channel of channels) ipcMain.removeHandler(channel); };
}
