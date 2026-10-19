import type { BrowserWindow, IpcMainInvokeEvent, Session, WebContents } from "electron";
import { navigationDecision, permissionAllowed, senderAllowed } from "./policy.js";
import type { Origins } from "./policy.js";

export function checkMainSender(event: IpcMainInvokeEvent, window: BrowserWindow | null, origins: Origins): void {
  const frame = event.senderFrame;
  if (!senderAllowed({ senderId: event.sender.id, mainWindowId: window?.webContents.id ?? null, isMainFrame: frame !== null && frame === event.sender.mainFrame, url: frame?.url ?? "" }, origins.serverOrigin)) {
    throw new Error("Desktop IPC is available only to the main app frame.");
  }
}

export function checkConnectSender(event: IpcMainInvokeEvent, window: BrowserWindow | null, connectUrl: string): void {
  if (window === null || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== connectUrl) {
    throw new Error("Connect IPC is available only to the bundled connect page.");
  }
}

export function secureSession(ses: Session, origins: Origins, getMain: () => BrowserWindow | null): void {
  const fromMain = (contents: WebContents | null): boolean => contents !== null && contents === getMain()?.webContents;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(fromMain(contents) && permissionAllowed(permission, details.requestingUrl, origins));
  });
  ses.setPermissionCheckHandler((contents, permission, origin, details) => {
    return fromMain(contents) && permissionAllowed(permission, details.requestingUrl ?? origin, origins);
  });
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  // This covers programmatic frame loads too, which will-frame-navigate does not emit for.
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType === "mainFrame" || details.resourceType === "subFrame") {
      callback({ cancel: navigationDecision(details.url, details.resourceType === "mainFrame", origins) !== "allow" });
    } else callback({});
  });
}

export function secureContents(contents: WebContents, origins: Origins, openExternal: (url: string) => Promise<void>, report: (error: unknown) => void): void {
  contents.on("will-frame-navigate", (event) => {
    const decision = navigationDecision(event.url, event.isMainFrame, origins);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") void openExternal(event.url).catch(report);
  });
  contents.on("will-redirect", (event) => {
    if (navigationDecision(event.url, event.isMainFrame, origins) !== "allow") event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (navigationDecision(url, true, origins) !== "block" && url.startsWith("https:")) void openExternal(url).catch(report);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}
