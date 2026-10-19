import { createHash } from "node:crypto";
import { DesktopInfo } from "@quokkabot/shared";
import { registrableDomain } from "@quokkabot/shared/node";
import { isIP } from "node:net";

export function validateOrigin(input: string): string {
  if (input !== input.trim() || /[\\\s]/u.test(input)) throw new Error("Enter a server origin without spaces or backslashes.");
  const url = new URL(input);
  if (input.includes("@")) throw new Error("Credentials are not allowed in a server origin.");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || /[?#]/u.test(input)) {
    throw new Error("Enter only the server origin, without a path, credentials, query or fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname.endsWith(".localhost"))) {
    throw new Error("Use HTTPS, or HTTP on a .localhost development hostname.");
  }
  // Reject paths that URL would silently normalise away, including /.. and percent-encoded dots.
  if (!/^https?:\/\/[^/]+\/?$/iu.test(input)) throw new Error("The server URL must contain only an origin.");
  return url.origin;
}

function site(host: string): string {
  if (host.endsWith(".")) throw new Error("Use a hostname without a trailing dot.");
  if (isIP(host.replace(/^\[|\]$/gu, "")) !== 0) return host;
  // Chromium uses the host itself when there is no registrable domain, for example an IP or localhost.
  return registrableDomain(host) ?? host;
}

export function validateServerPair(appInput: string, viewInput: string): { serverOrigin: string; viewOrigin: string } {
  const serverOrigin = validateOrigin(appInput);
  const viewOrigin = validateOrigin(viewInput);
  const app = new URL(serverOrigin);
  const view = new URL(viewOrigin);
  if (app.origin === view.origin || app.protocol !== view.protocol || site(app.hostname) !== site(view.hostname)) {
    throw new Error("The viewer must use another origin on the same site and scheme as the app.");
  }
  return { serverOrigin, viewOrigin };
}

export function partitionForOrigin(origin: string): string {
  return `persist:quokkabot-${createHash("sha256").update(validateOrigin(origin)).digest("hex").slice(0, 16)}`;
}

function versionNumbers(value: string): number[] {
  if (!/^\d+\.\d+\.\d+$/u.test(value)) throw new Error(`Unsupported desktop version: ${value}`);
  return value.split(".").map(Number);
}

export function checkDesktopInfo(body: unknown, enteredOrigin: string, version: string): ReturnType<typeof DesktopInfo.parse> {
  const info = DesktopInfo.parse(body);
  const origin = validateOrigin(enteredOrigin);
  if (info.appOrigin !== origin) throw new Error("The server's appOrigin does not match the entered origin.");
  const pair = validateServerPair(info.appOrigin, info.viewOrigin);
  const installed = versionNumbers(version);
  const minimum = versionNumbers(info.minDesktopVersion);
  for (let i = 0; i < 3; i += 1) {
    const actual = installed[i];
    const required = minimum[i];
    if (actual === undefined || required === undefined) throw new Error("Invalid version components.");
    if (actual > required) break;
    if (actual < required) throw new Error(`This server requires Quokka Bot ${info.minDesktopVersion} or newer.`);
  }
  return { ...info, viewOrigin: pair.viewOrigin };
}
