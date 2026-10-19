import type { Session } from "electron";
import { ApiError } from "@quokkabot/shared";
import { checkDesktopInfo, validateOrigin } from "./origins.js";

export interface ServerClient {
  readonly origin: string;
  sessionFetch(path: string, init?: RequestInit, timeoutMs?: number): Promise<Response>;
  json(path: string, init?: RequestInit): Promise<unknown>;
}

export async function responseError(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = ApiError.safeParse(body);
  return new Error(parsed.success ? parsed.data.error.message : `Server request failed with HTTP ${response.status}.`);
}

export class DesktopServer implements ServerClient {
  readonly origin: string;
  constructor(origin: string, readonly session: Session) { this.origin = validateOrigin(origin); }

  async sessionFetch(path: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
    if (!path.startsWith("/api/") || path.includes("\\")) throw new Error("Desktop requests must use an API path.");
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith("/api/")) throw new Error("Cross-origin or non-API desktop request refused.");
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") headers.set("Origin", this.origin);
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    // A redirect must never carry the device's cookies or a link poll token to another server.
    return this.session.fetch(url.href, { ...init, headers, credentials: "include", redirect: "error", signal });
  }

  async json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.sessionFetch(path, init);
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<unknown>;
  }

  async info(version: string): Promise<ReturnType<typeof checkDesktopInfo>> {
    return checkDesktopInfo(await this.json("/api/desktop/info"), this.origin, version);
  }
}
