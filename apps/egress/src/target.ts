import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { EgressDecision, ListenerKind } from "@quokkabot/shared";

export function isIpLiteral(host: string): boolean {
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(unwrapped) !== 0) return true;
  // WHATWG host parsing recognises decimal, hex, octal and shortened IPv4 forms.
  try {
    const parsed = new URL(`http://${host}/`).hostname;
    return isIP(parsed.replace(/^\[|\]$/g, "")) !== 0;
  } catch {
    return false;
  }
}

export function normalizeHost(host: string): string | null {
  if (/[/\\?#@:\s\[\]%]/.test(host)) return null;
  const ascii = domainToASCII(host.toLowerCase().replace(/\.$/, ""));
  if (ascii.length === 0 || ascii.length > 253) return null;
  if (!ascii.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) return null;
  if (/^[0-9]+$/.test(ascii.split(".").at(-1)!)) return null;
  return ascii;
}

export interface Target {
  host: string;
  port: number;
  path: string;
  connect: boolean;
}
export type TargetResult = { target: Target } | { decision: EgressDecision; status: number; host: string; port: number };

function splitAuthority(authority: string): { host: string; port: string | undefined } | null {
  const match = /^(\[[^\]]+\]|[^:/?#@\s\\]+)(?::([0-9]+))?$/.exec(authority);
  return match === null ? null : { host: match[1]!, port: match[2] };
}

export function parseTarget(method: string, url: string, kind: ListenerKind): TargetResult {
  const connect = method === "CONNECT";
  if (!connect && (kind === "cli" || !/^http:\/\//i.test(url))) {
    return { decision: "blocked_method", status: 405, host: "", port: 0 };
  }
  let authority = url;
  let path = "";
  if (!connect) {
    const match = /^http:\/\/([^/?#]*)([^#]*)$/i.exec(url);
    if (match === null) return { decision: "blocked_domain", status: 400, host: "", port: 0 };
    authority = match[1]!;
    path = match[2]!;
    if (path === "" || path.startsWith("?")) path = `/${path}`;
    if (path.includes("\\")) return { decision: "blocked_domain", status: 400, host: "", port: 0 };
  }
  const parts = splitAuthority(authority);
  if (parts === null || (connect && parts.port === undefined)) {
    return { decision: "blocked_domain", status: 400, host: "", port: 0 };
  }
  const port = parts.port === undefined ? 80 : Number(parts.port);
  // A malformed authority is never copied to the decision log, which must contain no URL data.
  const logHost = normalizeHost(parts.host) ?? (isIP(parts.host.replace(/^\[|\]$/g, "")) ? parts.host : "");
  if (port !== (connect ? 443 : 80)) return { decision: "blocked_port", status: 403, host: logHost, port: Number.isSafeInteger(port) ? port : 0 };
  if (isIpLiteral(parts.host)) return { decision: "blocked_ip_literal", status: 403, host: logHost, port };
  const host = normalizeHost(parts.host);
  if (host === null) return { decision: "blocked_domain", status: 400, host: "", port };
  if (isIpLiteral(host)) return { decision: "blocked_ip_literal", status: 403, host, port };
  return { target: { host, port, path, connect } };
}

export function hostHeaderMatches(header: string, host: string): boolean {
  const parts = splitAuthority(header);
  return parts !== null && (parts.port === undefined || Number(parts.port) === 80)
    && !isIpLiteral(parts.host) && normalizeHost(parts.host) === host;
}
