import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import { DesktopAuth, verificationUrl } from "../src/auth.js";
import { DesktopServer } from "../src/server.js";
import type { ServerClient } from "../src/server.js";

const origin = "https://app.example.com";
const code = "ABCD-EFGH";
const startResponse = () => ({ userCode: code, pollToken: "p".repeat(32), verifyUrl: `${origin}/link#${code}`, expiresAt: new Date(Date.now() + 60000).toISOString() });
function fakeServer(polls: Response[]): ServerClient & { paths: string[]; json: ReturnType<typeof vi.fn> } {
  const paths: string[] = [];
  const json = vi.fn(async (path: string) => {
    paths.push(path);
    if (path === "/api/desktop-link/start") return startResponse();
    if (path === "/api/me") return { ownerName: "", passkeys: 1, freshUntil: new Date(Date.now() + 60000).toISOString() };
    throw new Error(`Unexpected JSON path: ${path}`);
  });
  return {
    origin, paths, json,
    sessionFetch: async (path, init) => {
      expect(path).toBe("/api/desktop-link/poll");
      expect(JSON.parse(String(init?.body))).toEqual({ pollToken: "p".repeat(32) });
      const response = polls.shift();
      if (response === undefined) throw new Error("Unexpected extra poll.");
      return response;
    },
  };
}

describe("desktop sign-in", () => {
  it("keeps the poll token private, waits for approval, verifies /me and reloads only after sign-in", async () => {
    const server = fakeServer([Response.json({ state: "pending" }, { status: 202 }), Response.json({ state: "approved" })]);
    const open = vi.fn(async () => undefined);
    const signedIn = vi.fn(async () => undefined);
    const report = vi.fn();
    const auth = new DesktopAuth(server, open, signedIn, report, 1);
    const started = await auth.startSignIn();
    expect(started).toEqual({ userCode: code, expiresAt: expect.any(String) });
    expect(JSON.stringify(started)).not.toContain("pollToken");
    expect(open).toHaveBeenCalledWith(`${origin}/link#${code}`);
    expect(await auth.waitForFlow()).toBe("approved");
    expect(server.paths).toEqual(["/api/desktop-link/start", "/api/me"]);
    expect(signedIn).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });
  it("runs a fresh check in the existing session without reloading", async () => {
    const server = fakeServer([Response.json({ state: "approved" })]);
    const signedIn = vi.fn(async () => undefined);
    const auth = new DesktopAuth(server, async () => undefined, signedIn, vi.fn(), 1);
    await auth.startFreshCheck();
    expect(await auth.waitForFlow()).toBe("approved");
    expect(server.json.mock.calls[0]?.[0]).toBe("/api/desktop-link/start");
    expect(signedIn).not.toHaveBeenCalled();
  });
  it.each(["refused", "expired"] as const)("reports a %s link", async (state) => {
    const auth = new DesktopAuth(fakeServer([Response.json({ state }, { status: 410 })]), async () => undefined, async () => undefined, vi.fn(), 1);
    await auth.startSignIn();
    expect(await auth.waitForFlow()).toBe(state);
  });
  it("allows one flow at a time and settles cancellation promptly", async () => {
    const auth = new DesktopAuth(fakeServer([]), async () => undefined, async () => undefined, vi.fn(), 60000);
    await auth.startSignIn();
    await expect(auth.startFreshCheck()).rejects.toThrow(/already/u);
    auth.cancelFlow();
    expect(await auth.waitForFlow()).toBe("cancelled");
  });
  it("fails closed on inconsistent poll states and untrusted verification URLs", async () => {
    const report = vi.fn();
    const auth = new DesktopAuth(fakeServer([Response.json({ state: "approved" }, { status: 202 })]), async () => undefined, async () => undefined, report, 1);
    await auth.startSignIn();
    expect(await auth.waitForFlow()).toBe("error");
    expect(report).toHaveBeenCalledOnce();
    for (const value of ["https://evil.example/link#ABCD-EFGH", `${origin}/other#${code}`, `${origin}/link?secret=1#${code}`, `${origin}/link#OTHER`]) expect(() => verificationUrl(value, origin, code)).toThrow();
  });
  it("expires locally without polling a link beyond its deadline", async () => {
    const server = fakeServer([]);
    server.json.mockResolvedValueOnce({ ...startResponse(), expiresAt: new Date(Date.now() + 25).toISOString() });
    const auth = new DesktopAuth(server, async () => undefined, async () => undefined, vi.fn(), 10000);
    await auth.startSignIn();
    expect(await auth.waitForFlow()).toBe("expired");
  });
  it("does not approve a flow when a late HTTP response arrives after cancellation", async () => {
    const server = fakeServer([]);
    let reply!: (response: Response) => void;
    let requested!: () => void;
    const requestStarted = new Promise<void>((resolve) => { requested = resolve; });
    server.sessionFetch = async () => { requested(); return new Promise<Response>((resolve) => { reply = resolve; }); };
    const signedIn = vi.fn(async () => undefined);
    const auth = new DesktopAuth(server, async () => undefined, signedIn, vi.fn(), 1);
    await auth.startSignIn();
    await requestStarted;
    auth.cancelFlow();
    reply(Response.json({ state: "approved" }));
    expect(await auth.waitForFlow()).toBe("cancelled");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signedIn).not.toHaveBeenCalled();
    expect(server.paths).not.toContain("/api/me");
  });
});

describe("session-bound HTTP", () => {
  it("uses the selected Electron session, includes cookies and the exact Origin on mutations, and refuses redirects", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const server = new DesktopServer(origin, { fetch } as unknown as Session);
    await server.json("/api/me");
    await server.json("/api/agents/kill-all", { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" });
    const get = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const post = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(get[0]).toBe(`${origin}/api/me`);
    expect(post[1].credentials).toBe("include");
    expect(post[1].redirect).toBe("error");
    expect(new Headers(post[1].headers).get("Origin")).toBe(origin);
    expect(new Headers(post[1].headers).get("Content-Type")).toBe("application/json");
    await expect(server.sessionFetch("https://evil.example/api/me")).rejects.toThrow();
    await expect(server.sessionFetch("//evil.example/api/me")).rejects.toThrow();
    await expect(server.sessionFetch("/api/../desktop/private")).rejects.toThrow();
  });
  it("reports server errors clearly", async () => {
    const server = new DesktopServer(origin, { fetch: async () => Response.json({ error: { code: "no_session", message: "Sign in first." } }, { status: 401 }) } as unknown as Session);
    await expect(server.json("/api/me")).rejects.toThrow("Sign in first.");
  });
});
