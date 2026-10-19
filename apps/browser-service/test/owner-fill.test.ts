import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserCommandResult, OwnerFillRequest } from "@quokkabot/shared";
import { systemClock } from "../src/runtime.js";
import { harness, until } from "./helpers.js";
import type { Harness } from "./helpers.js";

const instances: Harness[] = [];
const request: OwnerFillRequest = { commandId: "owner_fill_command", leaseGeneration: 3, kind: "password", value: "native-canary-! --secret\n€", expectedOrigin: "https://example.com", submit: false };
async function setup(options?: Parameters<typeof harness>[0]) {
  const h = await harness(options); instances.push(h);
  await h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
  return h;
}
afterEach(async () => {
  try { for (const h of instances.splice(0)) await h.cleanup(); }
  finally { vi.restoreAllMocks(); }
});
async function fill(h: Harness, patch: Partial<OwnerFillRequest> = {}) {
  return (await h.request("POST", "/v1/owner-fill", { ...request, ...patch })).body as BrowserCommandResult;
}
function focus(h: Harness, generation = 3) { return h.request("GET", `/v1/owner-focus?generation=${generation}`); }
function inserts(h: Harness) { return h.cdp.calls.filter((call) => call.method === "Runtime.callFunctionOn"); }
function field(h: Harness) { return h.cdp.frames[0]!.field!; }
async function resume(h: Harness, generation = 4) { await h.service.setControlLease({ holder: "agent", generation, expiresAt: null }); }

describe("owner native fields", () => {
  it.each(["agent", "paused", "expired", "obsolete", "changing"])("refuses the %s lease before touching a page", async (state) => {
    const h = await setup();
    let transition: Promise<unknown> | undefined;
    if (state === "agent" || state === "paused") await h.service.setControlLease({ holder: state, generation: 4, expiresAt: null });
    if (state === "expired") await h.service.setControlLease({ holder: "owner", generation: 4, expiresAt: "2000-01-01T00:00:00Z" });
    if (state === "changing") transition = h.service.setControlLease({ holder: "paused", generation: 4, expiresAt: null });
    const generation = state === "obsolete" ? 2 : state === "changing" ? 3 : 4;
    const before = h.cdp.calls.length;
    expect(await fill(h, { leaseGeneration: generation })).toMatchObject({ status: "blocked" });
    expect((await focus(h, generation)).body).toMatchObject({ status: "blocked" });
    expect(h.cdp.calls.length).toBe(before);
    await transition;
  });

  it("returns only kind and origin and types exactly once without moving focus or exposing the value", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((name) => vi.spyOn(console, name as "log").mockImplementation(() => undefined));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const h = await setup();
    expect((await focus(h)).body).toEqual({ field: { origin: "https://example.com", kind: "password" } });
    const result = await fill(h);
    expect(result).toEqual({ commandId: request.commandId, status: "ok" });
    expect(h.cdp.frames[0]!.inserted).toBe(request.value);
    expect(await fill(h)).toEqual(result);
    expect((await fill(h, { value: "different" })).status).toBe("invalid");
    expect(inserts(h)).toHaveLength(1);
    const cached = await h.request("GET", `/v1/commands/${request.commandId}`);
    expect(cached.body).toEqual(result);
    expect((await focus(h)).body).toEqual({ field: { origin: "https://example.com", kind: "password" } });
    const argv = await readFile(join(h.root, "argv.jsonl"), "utf8");
    expect((await h.calls()).some((args) => ["focus", "fill", "type", "press", "tab"].includes(args[7] ?? ""))).toBe(false);
    expect(JSON.stringify([cached.body, logs.flatMap((spy) => spy.mock.calls), stdout.mock.calls, stderr.mock.calls]) + argv).not.toContain(request.value);
    expect((await h.request("POST", "/v1/commands", { ...request, op: { op: "owner-fill" } })).body).toMatchObject({ status: "invalid" });
  });

  it.each(["none", "two frames", "two pages", "ZIP", "read only", "http"])("returns null for %s", async (state) => {
    const h = await setup();
    if (state === "none") h.cdp.frames[0]!.field = null;
    if (state === "two frames") h.cdp.frames.push({ id: "frame_other", origin: "https://example.com", parentId: "frame_main", field: { ...field(h) }, outOfProcess: true });
    if (state === "two pages") {
      h.cdp.targets.push({ type: "page", url: "https://example.com/other" });
      h.cdp.frames.push({ id: "frame_other", origin: "https://example.com", parentId: null, field: { ...field(h) }, pageTarget: "target_2" });
    }
    if (state === "ZIP") Object.assign(field(h), { type: "text", autocomplete: "", maxLength: 5, hints: "zip" });
    if (state === "read only") field(h).readOnly = true;
    if (state === "http") h.cdp.frames[0]!.origin = "http://example.com";
    expect((await focus(h)).body).toEqual({ field: null });
    expect((await fill(h)).status).toBe("blocked");
    expect(inserts(h)).toEqual([]);
  });

  it("finds the sole focused field in a remote frame on another page", async () => {
    const h = await setup();
    const password = { ...field(h) };
    h.cdp.frames[0]!.field = null;
    h.cdp.targets.push({ type: "page", url: "https://example.com/other" });
    h.cdp.frames.push(
      { id: "frame_second", origin: "https://example.com", parentId: null, field: null, pageTarget: "target_2" },
      { id: "frame_login", origin: "https://login.example.com", parentId: "frame_second", field: password, pageTarget: "target_2", outOfProcess: true },
    );
    expect((await focus(h)).body).toEqual({ field: { origin: "https://login.example.com", kind: "password" } });
    expect((await fill(h, { expectedOrigin: "https://login.example.com", submit: true })).status).toBe("ok");
    expect(inserts(h)[0]?.sessionId).toBe("session_frame_login");
    expect(h.cdp.calls.filter((call) => call.method === "Input.dispatchKeyEvent").map((call) => call.sessionId)).toEqual(["session_target_2", "session_target_2"]);
  });

  it.each([
    { type: "text", autocomplete: "section-login one-time-code" }, { type: "number", inputMode: "numeric" },
    ...["code", "otp", "totp", "2fa", "mfa", "verification", "verify", "authenticator", "pin"].map((hints) => ({ type: "text", hints })),
  ])("allows a clearly named code field %j", async (attributes) => {
    const h = await setup();
    Object.assign(field(h), { autocomplete: "", ...attributes });
    expect((await focus(h)).body).toEqual({ field: { origin: "https://example.com", kind: "code" } });
    expect((await fill(h, { kind: "code", value: "123456" })).status).toBe("ok");
  });

  it.each(["kind", "ZIP", "http", "origin", "atomic origin", "atomic kind", "atomic ZIP"])("refuses %s without typing", async (change) => {
    const h = await setup();
    expect((await focus(h)).statusCode).toBe(200);
    if (change === "kind") field(h).type = "text";
    if (change === "ZIP") Object.assign(field(h), { type: "text", autocomplete: "", maxLength: 6, hints: "zip" });
    if (change === "http") h.cdp.frames[0]!.origin = "http://example.com";
    if (change === "origin") h.cdp.frames[0]!.origin = "https://other.example";
    if (change === "atomic ZIP") Object.assign(field(h), { type: "text", autocomplete: "one-time-code", maxLength: 6 });
    h.cdp.onSend = (method) => {
      if (method !== "Runtime.callFunctionOn") return;
      if (change === "atomic origin") h.cdp.frames[0]!.origin = "https://other.example";
      if (change === "atomic kind") field(h).type = "text";
      if (change === "atomic ZIP") field(h).autocomplete = "";
    };
    expect((await fill(h, { kind: change.includes("ZIP") ? "code" : "password" })).status).toBe("blocked");
    expect(h.cdp.frames.every((frame) => frame.inserted === undefined)).toBe(true);
  });

  it.each(["test", "production"])("allows localhost HTTP only in test, under %s", async (env) => {
    const h = await setup({ env: { NODE_ENV: env } });
    h.cdp.frames[0]!.origin = "http://fixture.localhost";
    expect((await fill(h, { expectedOrigin: "http://fixture.localhost" })).status).toBe(env === "test" ? "ok" : "blocked");
  });

  it.each(["changing", "expired"])("fences a lease that becomes %s during inspection", async (change) => {
    let now = new Date();
    const h = await setup({ clock: { ...systemClock, now: () => now } });
    await h.service.setControlLease({ holder: "owner", generation: 4, expiresAt: new Date(now.getTime() + 1000).toISOString() });
    let transition: Promise<unknown> | undefined;
    h.cdp.onSend = (method) => {
      if (method !== "Runtime.evaluate") return;
      if (change === "changing") transition = h.service.setControlLease({ holder: "paused", generation: 5, expiresAt: null });
      else now = new Date(now.getTime() + 2000);
    };
    expect((await fill(h, { leaseGeneration: 4 })).status).toBe("outcome_unknown");
    await transition;
    expect(inserts(h)).toEqual([]);
    expect(h.cdp.frames[0]!.inserted).toBeUndefined();
  });

  it("aborts a stalled inspection after lease grace and never types after it resumes", async () => {
    const clock = { ...systemClock, setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms === 10_000 ? 25 : ms === 1000 ? 3_600_000 : ms) };
    const h = await setup({ clock });
    const original = h.cdp.send.bind(h.cdp);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    h.cdp.send = async (method, params, sessionId) => {
      const result = await original(method, params, sessionId);
      if (method === "Runtime.evaluate") await wait;
      return result;
    };
    const action = fill(h, { submit: true });
    await until(async () => h.cdp.calls.some((call) => call.method === "Runtime.evaluate"));
    await h.service.setControlLease({ holder: "paused", generation: 4, expiresAt: null });
    expect((await action).status).toBe("outcome_unknown");
    expect(h.cdp.connected).toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inserts(h)).toEqual([]);
    expect(h.cdp.calls.some((call) => call.method.startsWith("Input."))).toBe(false);
    await h.cdp.connect();
  });

  it("serializes owner fills, focus and agent commands on the same queue", async () => {
    const h = await setup();
    const original = h.cdp.send.bind(h.cdp);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    h.cdp.send = async (method, params, sessionId) => {
      const result = await original(method, params, sessionId);
      if (method === "Runtime.callFunctionOn") await wait;
      return result;
    };
    const action = fill(h);
    await until(async () => inserts(h).length === 1);
    const duplicate = fill(h);
    let commandDone = false;
    const agent = h.command({ op: "tabs" }).then((result) => { commandDone = true; return result; });
    const before = h.cdp.calls.length;
    const inspection = focus(h);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(commandDone).toBe(false);
    expect(h.cdp.calls.length).toBe(before);
    release();
    expect(await action).toEqual(await duplicate);
    expect((await agent).status).toBe("blocked");
    expect((await inspection).statusCode).toBe(200);
    expect(inserts(h)).toHaveLength(1);
  });

  it("aborts a stalled insertion and sends no late Enter", async () => {
    const clock = { ...systemClock, setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms === 10_000 ? 25 : ms === 1000 ? 3_600_000 : ms) };
    const h = await setup({ clock });
    const original = h.cdp.send.bind(h.cdp);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    h.cdp.send = async (method, params, sessionId) => {
      const result = await original(method, params, sessionId);
      if (method === "Runtime.callFunctionOn") await wait;
      return result;
    };
    const action = fill(h, { submit: true });
    await until(async () => inserts(h).length === 1);
    await h.service.setControlLease({ holder: "agent", generation: 4, expiresAt: null });
    expect((await action).status).toBe("outcome_unknown");
    expect(h.cdp.connected).toBe(false);
    expect(h.cdp.frames[0]!.inserted).toBe(request.value);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.cdp.calls.some((call) => call.method.startsWith("Input."))).toBe(false);
    await h.cdp.connect();
  });

  it.each([false, true])("blocks screenshots after insertion, including uncertainty %s, until a top-level load", async (uncertain) => {
    const h = await setup();
    if (uncertain) h.cdp.failMethod = "Runtime.callFunctionOn";
    expect((await fill(h)).status).toBe(uncertain ? "outcome_unknown" : "ok");
    h.cdp.failMethod = undefined;
    await resume(h);
    expect((await h.command({ op: "screenshot", tab: "t1" }, 4)).status).toBe("blocked");
    h.cdp.event("Target.detachedFromTarget", { sessionId: "session_target_1" });
    expect((await h.command({ op: "screenshot", tab: "t1" }, 4)).status).toBe("blocked");
    h.cdp.event("Page.frameNavigated", { frame: { id: "frame_child", parentId: "frame_main" } }, "session_target_1");
    expect((await h.command({ op: "screenshot", tab: "t1" }, 4)).status).toBe("blocked");
    h.cdp.event("Page.frameNavigated", { frame: { id: "frame_main" } }, "session_target_1");
    expect((await h.command({ op: "screenshot", tab: "t1" }, 4)).status).toBe("ok");
  });

  it("releases Enter after navigation without blocking screenshots of the new page", async () => {
    const h = await setup();
    h.cdp.onSend = (method) => {
      if (method === "Input.dispatchKeyEvent" && h.cdp.calls.at(-1)?.params.type === "keyDown") h.cdp.event("Page.frameNavigated", { frame: { id: "frame_main" } }, "session_target_1");
    };
    expect((await fill(h, { submit: true })).status).toBe("ok");
    expect(h.cdp.calls.filter((call) => call.method === "Input.dispatchKeyEvent")).toHaveLength(2);
    await resume(h);
    expect((await h.command({ op: "screenshot", tab: "t1" }, 4)).status).toBe("ok");
  });

  it("returns fixed errors for malformed requests and upstream errors containing the value", async () => {
    const h = await setup();
    expect((await fill(h, { value: "" })).status).toBe("invalid");
    expect((await fill(h, { expectedOrigin: request.value })).status).toBe("invalid");
    h.cdp.send = async () => { throw new Error(request.value); };
    const result = await fill(h);
    expect(result).toEqual({ commandId: request.commandId, status: "outcome_unknown", message: "owner fill failed" });
    expect(JSON.stringify(result)).not.toContain(request.value);
    h.cdp.send = Object.getPrototypeOf(h.cdp).send.bind(h.cdp);
  });
});
