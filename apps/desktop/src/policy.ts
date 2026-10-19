export interface Origins { serverOrigin: string; viewOrigin: string }

export function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || !["https:", "http:"].includes(url.protocol)) return null;
    return url.origin;
  } catch { return null; }
}

export function isExternalHttps(value: string): boolean {
  return safeOrigin(value) !== null && new URL(value).protocol === "https:";
}

export function navigationDecision(url: string, isMainFrame: boolean, origins: Origins): "allow" | "external" | "block" {
  const origin = safeOrigin(url);
  if (origin === origins.serverOrigin || (!isMainFrame && origin === origins.viewOrigin)) return "allow";
  return isMainFrame && isExternalHttps(url) ? "external" : "block";
}

export function permissionAllowed(permission: string, requestingUrl: string, origins: Origins): boolean {
  const origin = safeOrigin(requestingUrl);
  if (permission === "notifications") return origin === origins.serverOrigin;
  return ["fullscreen", "pointerLock", "keyboardLock"].includes(permission) && origin === origins.viewOrigin;
}

export function senderAllowed(sender: { senderId: number; mainWindowId: number | null; isMainFrame: boolean; url: string }, appOrigin: string): boolean {
  return sender.mainWindowId !== null && sender.senderId === sender.mainWindowId && sender.isMainFrame && safeOrigin(sender.url) === appOrigin;
}

export function routeAllowed(route: string): boolean {
  return route === "/" || route === "/?new=1" || /^\/tasks\/[0-9a-f-]{36}$/u.test(route) || /^\/agents\/[0-9a-f-]{36}(?:\/(?:computer|tasks|files|domains|logins|audit|settings))?$/u.test(route);
}
