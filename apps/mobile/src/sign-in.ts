import { z } from "zod";
import {
  DesktopInfo, DesktopLinkStartResponse, PhoneCodeRequest, PhoneLinkPollResponse, PhoneLinkStartRequest,
  PhonePasskeyOptionsResponse, PhonePasskeyVerifyRequest, PhoneSessionResponse,
} from "@quokkabot/shared";
import { ApiFailure, call, type Fetch } from "./api";
import type { Connection } from "./connection";

// How a phone signs in, for any server: find out what it is, then a passkey (only on the domain built into the app),
// a link approved in a browser, or a code from the server's operator. Each ends in a Connection to keep.

// What the owner typed or scanned, as an origin. HTTPS only: the phone holds a session token, and the server's
// certificate is what proves the address. http is allowed for *.localhost, the development server.
export function serverOrigin(input: string): string {
  let text = input.trim();
  const scanned = /^quokkabot(?:-dev|-preview)?:\/\/connect\?/.test(text) ? new URL(text).searchParams.get("server") : null;
  if (scanned !== null) text = scanned;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("That is not a server address."); }
  const localhost = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) throw new Error("The server needs an https address.");
  if (url.username || url.password) throw new Error("The address cannot hold a user name or password.");
  return url.origin;
}

// The server's own description. It must be Quokka Bot, at the address the owner gave, and new enough for the phone.
export async function discover(fetchImpl: Fetch, origin: string): Promise<{ origin: string; viewOrigin: string }> {
  let info: DesktopInfo;
  try {
    info = await call(fetchImpl, origin, "/desktop/info", DesktopInfo);
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 404) throw new Error(`${new URL(origin).host} is not a Quokka Bot server.`);
    throw error;
  }
  if (info.appOrigin !== origin) throw new Error(`This server's address is ${info.appOrigin}. Connect to that address.`);
  if (info.phoneApi !== 1) throw new Error("This server is too old for the iPhone app. Update it first.");
  return { origin: info.appOrigin, viewOrigin: info.viewOrigin };
}

export async function signInWithCode(fetchImpl: Fetch, server: { origin: string; viewOrigin: string }, code: string, deviceName: string): Promise<Connection> {
  const body = PhoneCodeRequest.parse({ code, deviceName });
  const { token } = await call(fetchImpl, server.origin, "/phone/code", PhoneSessionResponse, { method: "POST", body });
  return { ...server, token };
}

// A passkey made for the domain built into the app. `getAssertion` is the system's passkey sheet.
export async function signInWithPasskey(fetchImpl: Fetch, server: { origin: string; viewOrigin: string }, deviceName: string,
  getAssertion: (options: Record<string, unknown>) => Promise<unknown>): Promise<Connection> {
  const { challengeId, options } = await call(fetchImpl, server.origin, "/phone/passkey/options", PhonePasskeyOptionsResponse, { method: "POST", body: {} });
  const response = await getAssertion(options);
  const body = PhonePasskeyVerifyRequest.parse({ challengeId, response, deviceName });
  const { token } = await call(fetchImpl, server.origin, "/phone/passkey/verify", PhoneSessionResponse, { method: "POST", body });
  return { ...server, token };
}

export type LinkStart = z.infer<typeof DesktopLinkStartResponse>;
export type LinkState = "pending" | "refused" | "expired";

export function startLink(fetchImpl: Fetch, origin: string, deviceName: string): Promise<LinkStart> {
  return call(fetchImpl, origin, "/phone/link/start", DesktopLinkStartResponse, { method: "POST", body: PhoneLinkStartRequest.parse({ deviceName }) });
}

// One look at a link: the token once it is approved, else its state. 202 and 410 carry the state.
export async function pollLink(fetchImpl: Fetch, origin: string, pollToken: string): Promise<{ token: string } | { state: LinkState }> {
  const response = await fetchImpl(`${origin}/api/phone/link/poll`, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ pollToken }),
  });
  if (![200, 202, 410].includes(response.status)) {
    throw new ApiFailure(`Checking the approval failed (HTTP ${response.status})`, response.status, "poll_failed");
  }
  const result = PhoneLinkPollResponse.parse(await response.json());
  return result.state === "approved" ? { token: result.token } : { state: result.state };
}

// Polls every two seconds until the owner approves or refuses, or the link expires. Stops when `stopped` says so.
export async function waitForLink(fetchImpl: Fetch, origin: string, pollToken: string, stopped: () => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<{ token: string } | { state: "refused" | "expired" | "stopped" }> {
  for (;;) {
    if (stopped()) return { state: "stopped" };
    const result = await pollLink(fetchImpl, origin, pollToken);
    if ("token" in result) return result;
    if (result.state !== "pending") return { state: result.state };
    await sleep(2000);
  }
}
