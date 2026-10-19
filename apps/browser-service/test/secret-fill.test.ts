import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunId } from "@quokkabot/shared";
import type { BrowserCommandResult, SecretFillRequest } from "@quokkabot/shared";
import { systemClock } from "../src/runtime.js";
import { FOCUSED_FIELD_EXPRESSION, INSERT_FUNCTION } from "../src/secret-fill.js";
import { harness, RUN_ID, until } from "./helpers.js";
import type { FakeFrame, Harness } from "./helpers.js";

const instances: Harness[] = [];
async function setup(options?: Parameters<typeof harness>[0]) {
  const h = await harness(options); instances.push(h); return h;
}
afterEach(async () => {
  try { for (const h of instances.splice(0)) await h.cleanup(); }
  finally { vi.restoreAllMocks(); }
});
async function requestFor(h: Harness, patch: Partial<SecretFillRequest> = {}): Promise<SecretFillRequest> {
  const snapshot = await h.command({ op: "snapshot", tab: "t1" });
  expect(snapshot.status).toBe("ok");
  if (snapshot.snapshot === undefined) throw new Error("Test snapshot omitted generation");
  return {
    commandId: "secret_command", runId: RunId.parse(RUN_ID), generation: 2, tab: "t1", snapshot: snapshot.snapshot,
    ref: "e2", kind: "password", value: "vault-canary-! --secret\n€", allowedPatterns: ["example.com"], submit: false,
    ...patch,
  };
}
async function fill(h: Harness, request: SecretFillRequest): Promise<BrowserCommandResult> {
  const response = await h.request("POST", "/v1/secret-fill", request);
  expect(response.statusCode).toBe(200);
  return response.body as BrowserCommandResult;
}
function inputs(h: Harness) { return h.cdp.calls.filter((call) => call.method.startsWith("Input.")); }
function inserts(h: Harness) { return h.cdp.calls.filter((call) => call.method === "Runtime.callFunctionOn"); }
function field(h: Harness): NonNullable<FakeFrame["field"]> {
  const selected = h.cdp.frames[0]?.field;
  if (!selected) throw new Error("Test has no focused field");
  return selected;
}

describe("secret fill", () => {
  it("inserts the exact secret through the page CDP session, with no value in argv, logs, snapshots or cached replies", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((name) => vi.spyOn(console, name as "log").mockImplementation(() => undefined));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const h = await setup();
    const request = await requestFor(h);
    const before = (await h.calls()).length;
    const result = await fill(h, request);
    expect(result).toEqual({ commandId: request.commandId, status: "ok" });
    // One in-page call checks the site and field and inserts the value; nothing else touches the page.
    expect(inputs(h)).toEqual([]);
    expect(inserts(h)).toHaveLength(1);
    expect(inserts(h)[0]?.params).toMatchObject({
      functionDeclaration: INSERT_FUNCTION, executionContextId: expect.any(Number),
      arguments: [{ value: "password" }, { value: "https://example.com" }, { value: request.value }],
    });
    expect(inserts(h)[0]?.sessionId).toBe("session_target_1");
    expect(h.cdp.frames[0]?.inserted).toBe(request.value);
    const calls = await h.calls();
    expect(calls.slice(before).map((argv) => argv.slice(7))).toEqual([["tab", "list"], ["focus", "@e2"]]);
    for (const argv of calls) for (const argument of argv) expect(argument).not.toContain(request.value);
    for (const call of h.cdp.calls.filter((call) => call.method === "Runtime.evaluate")) {
      expect(call.params.expression).toBe(FOCUSED_FIELD_EXPRESSION);
      expect(call.params.contextId).toEqual(expect.any(Number));
      expect(call.params).not.toHaveProperty("objectGroup");
    }
    const cached = await h.request("GET", `/v1/commands/${request.commandId}`);
    expect(cached.body).toEqual(result);
    expect(JSON.stringify(cached.body)).not.toContain(request.value);
    expect(cached.body).not.toHaveProperty("value");
    // Refilling with the same id must use the cache rather than type twice.
    expect(await fill(h, request)).toEqual(result);
    expect((await fill(h, { ...request, value: "different-value" })).status).toBe("invalid");
    expect((await h.command({ op: "tabs" }, 2, request.commandId)).status).toBe("invalid");
    expect(inserts(h)).toHaveLength(1);
    await h.config({ snapshot: `- textbox "Password" [ref=e2]: ${request.value}\n  - StaticText "${request.value}"` });
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    expect(snapshot.text).toBe('- textbox "Password" [ref=e2]: [hidden]');
    const output = JSON.stringify([...logs.flatMap((spy) => spy.mock.calls), ...stdout.mock.calls, ...stderr.mock.calls]);
    expect(output).not.toContain(request.value);
    expect(output).not.toContain("vault-canary");
    const argvLog = await readFile(join(h.root, "argv.jsonl"), "utf8");
    expect(argvLog).not.toContain("vault-canary");
  });

  it.each([
    ["https://attacker.example", ["example.com"], "wrong site: the field is on attacker.example"],
    ["https://example.com.attacker.example", ["*.example.com"], "wrong site: the field is on example.com.attacker.example"],
    ["https://login.example.com", ["*.example.com"], "ok"],
    ["https://example.com", ["*.example.com"], "ok"],
    ["http://example.com", ["example.com"], "wrong site: http://example.com is not HTTPS"],
    ["null", ["example.com"], "wrong site"],
    ["http://fixture.localhost", ["fixture.localhost"], "ok"],
  ] as const)("checks the focused iframe origin %s against %j", async (origin, allowedPatterns, outcome) => {
    const h = await setup();
    const focusedField = field(h);
    h.cdp.frames = [
      { id: "frame_main", origin: "https://example.com", parentId: null, field: null },
      { id: "frame_login", origin, parentId: "frame_main", field: focusedField, outOfProcess: true },
    ];
    const request = await requestFor(h, { allowedPatterns: [...allowedPatterns] });
    expect(await fill(h, request)).toEqual({ commandId: request.commandId, ...(outcome === "ok" ? { status: "ok" } : { status: "blocked", message: outcome }) });
    if (outcome !== "ok") expect(inserts(h)).toEqual([]);
    expect(h.cdp.calls.filter((call) => call.method === "Page.createIsolatedWorld").map((call) => call.params.frameId))
      .toContain("frame_login");
    expect(h.cdp.calls.find((call) => call.method === "Page.createIsolatedWorld" && call.params.frameId === "frame_login")?.sessionId)
      .toBe("session_frame_login");
    // The insertion runs in the frame that holds the field.
    for (const call of inserts(h)) expect(call.sessionId).toBe("session_frame_login");
  });

  it.each([
    { kind: "password", type: "text" },
    { kind: "password", type: "email" },
    { kind: "username", type: "password" },
    { kind: "code", type: "password", autocomplete: "one-time-code", maxLength: 6, inputMode: "numeric" },
    { kind: "code", type: "email", maxLength: 6 },
    { kind: "code", type: "checkbox" },
    { kind: "code", type: "text" },
    { kind: "code", type: "text", hints: "search" },
    { kind: "code", type: "text", maxLength: 3 },
    { kind: "code", type: "text", maxLength: 11 },
    { kind: "code", type: "number" },
    { kind: "code", type: "text", hints: "barcode" },
    { kind: "password", type: "password", tag: "textarea" },
    { kind: "password", type: "password", readOnly: true },
    { kind: "password", type: "password", disabled: true },
  ] as const)("blocks a wrong field kind %j before any input", async (entry) => {
    const h = await setup();
    const { kind, ...attributes } = entry;
    Object.assign(field(h), { autocomplete: "", ...attributes });
    const request = await requestFor(h, { kind });
    expect(await fill(h, request)).toEqual({ commandId: request.commandId, status: "blocked", message: "wrong field kind" });
    expect(inserts(h)).toEqual([]);
  });

  it.each([
    { kind: "username", type: "text" }, { kind: "username", type: "email" }, { kind: "username", type: "tel" },
    { kind: "code", type: "text", maxLength: 4 }, { kind: "code", type: "tel", maxLength: 10 },
    { kind: "code", type: "number", inputMode: "numeric" }, { kind: "code", type: "text", hints: "otp" },
    { kind: "code", type: "text", hints: "verification_code" }, { kind: "code", type: "tel", hints: "2fa-token" },
    { kind: "code", type: "text", autocomplete: "section-login one-time-code" },
  ] as const)("allows the requested field kind %j", async (entry) => {
    const h = await setup();
    const { kind, ...attributes } = entry;
    Object.assign(field(h), { autocomplete: "", ...attributes });
    // A value the field can hold: code fields often limit their length.
    expect((await fill(h, await requestFor(h, { kind, value: kind === "code" ? "1234" : "owner@example.com" }))).status).toBe("ok");
  });

  it.each(["kind", "origin", "focus"])("checks the %s again in the same page task as the insertion", async (change) => {
    const h = await setup();
    const request = await requestFor(h);
    // The page changes between the inspection and the insertion call.
    h.cdp.onSend = (method) => {
      if (method === "Runtime.callFunctionOn") {
        if (change === "kind") field(h).type = "text";
        else if (change === "origin") h.cdp.frames[0]!.origin = "https://attacker.example";
        else h.cdp.frames[0]!.field = null;
      }
    };
    expect(await fill(h, request)).toMatchObject({ status: "blocked", message: change === "origin" ? "wrong site" : "wrong field kind" });
    expect(h.cdp.frames[0]?.inserted).toBeUndefined();
  });

  it("reports a field that did not take the whole value as failed", async () => {
    const h = await setup();
    Object.assign(field(h), { type: "text", maxLength: 6, autocomplete: "one-time-code" });
    const request = await requestFor(h, { kind: "code", value: "12345678" });
    expect(await fill(h, request)).toMatchObject({ status: "failed", message: "the field did not accept the value" });
  });

  it("blocks screenshots of the page a saved login was typed into, until another page loads", async () => {
    const h = await setup();
    expect((await h.command({ op: "screenshot", tab: "t1" })).status).toBe("ok");
    expect((await fill(h, await requestFor(h))).status).toBe("ok");
    const blocked = await h.command({ op: "screenshot", tab: "t1" }, 2, "shot_after_fill");
    expect(blocked).toMatchObject({ status: "blocked" });
    expect(blocked.message).toContain("browser_snapshot");
    // A frame inside the page loading is not a new page.
    h.cdp.event("Page.frameNavigated", { frame: { id: "frame_ad", parentId: "frame_main" } }, "session_target_1");
    expect((await h.command({ op: "screenshot", tab: "t1" }, 2, "shot_after_subframe")).status).toBe("blocked");
    h.cdp.event("Page.frameNavigated", { frame: { id: "frame_main" } }, "session_target_1");
    expect((await h.command({ op: "screenshot", tab: "t1" }, 2, "shot_after_navigation")).status).toBe("ok");
  });

  it("does not block screenshots of the page that Enter loaded", async () => {
    const h = await setup();
    const request = await requestFor(h, { submit: true });
    h.cdp.onSend = (method) => {
      const last = h.cdp.calls.at(-1);
      if (method === "Input.dispatchKeyEvent" && last?.params.key === "Enter" && last.params.type === "keyDown") {
        h.cdp.event("Page.frameNavigated", { frame: { id: "frame_main" } }, "session_target_1");
      }
    };
    expect((await fill(h, request)).status).toBe("ok");
    expect((await h.command({ op: "screenshot", tab: "t1" }, 2, "shot_next_page")).status).toBe("ok");
  });

  it("requires HTTPS on localhost outside the test environment", async () => {
    const h = await setup({ env: { NODE_ENV: "production" } });
    h.cdp.frames[0]!.origin = "http://fixture.localhost";
    const request = await requestFor(h, { allowedPatterns: ["fixture.localhost"] });
    expect(await fill(h, request)).toMatchObject({ status: "blocked", message: "wrong site: http://fixture.localhost is not HTTPS" });
    expect(inserts(h)).toEqual([]);
  });

  it("supports an in-process iframe and invalidates its snapshot on frame navigation", async () => {
    const h = await setup();
    const focusedField = field(h);
    h.cdp.frames = [
      { id: "frame_main", origin: "https://example.com", parentId: null, field: null },
      { id: "frame_login", origin: "https://example.com", parentId: "frame_main", field: focusedField },
    ];
    const request = await requestFor(h);
    expect((await fill(h, request)).status).toBe("ok");
    expect(h.cdp.calls.find((call) => call.method === "Page.createIsolatedWorld" && call.params.frameId === "frame_login")?.sessionId)
      .toBe("session_target_1");
    h.cdp.event("Page.frameNavigated", { frame: { id: "frame_login" } }, "session_target_1");
    expect(await fill(h, { ...request, commandId: "navigated_frame" })).toMatchObject({ status: "invalid", message: "take a new snapshot" });
  });

  it("fences a remote frame navigation while inspecting it without inserting a value", async () => {
    const h = await setup();
    const focusedField = field(h);
    h.cdp.frames = [
      { id: "frame_main", origin: "https://example.com", parentId: null, field: null },
      { id: "frame_login", origin: "https://example.com", parentId: "frame_main", field: focusedField, outOfProcess: true },
    ];
    const request = await requestFor(h);
    const send = h.cdp.send.bind(h.cdp);
    h.cdp.send = async (method, params, sessionId) => {
      const result = await send(method, params, sessionId);
      // Chrome read the old field, then destroyed that world before the service can insert.
      if (method === "Runtime.evaluate" && sessionId === "session_frame_login") {
        h.cdp.event("Page.frameNavigated", { frame: { id: "frame_login" } }, "session_frame_login");
      }
      return result;
    };
    expect(await fill(h, request)).toMatchObject({ status: "invalid", message: "take a new snapshot" });
    expect(inputs(h)).toEqual([]);
  });

  it("rejects stale snapshots, missing refs and missing tabs before focus", async () => {
    const h = await setup();
    const old = await requestFor(h);
    const current = await h.command({ op: "snapshot", tab: "t1" });
    for (const [index, patch] of [{}, { snapshot: current.snapshot!, ref: "e999" }, { tab: "t99" }].entries()) {
      const result = await fill(h, { ...old, ...patch, commandId: `invalid_${index}` });
      expect(result.status).toBe("invalid");
      expect(result.message).toBe("take a new snapshot");
    }
    expect((await h.calls()).some((argv) => argv[7] === "focus")).toBe(false);
    expect(inputs(h)).toEqual([]);
  });

  it("requires a new snapshot after switching targets, then keeps active-tab refs intact", async () => {
    const h = await setup();
    const request = await requestFor(h);
    await h.command({ op: "open", url: "https://example.com/other" });
    expect(await fill(h, request)).toMatchObject({ status: "invalid", message: "take a new snapshot" });
    expect((await h.calls()).some((argv) => argv[7] === "focus")).toBe(false);
    const fresh = await requestFor(h, { commandId: "fresh_secret" });
    const before = (await h.calls()).length;
    expect((await fill(h, fresh)).status).toBe("ok");
    expect((await h.calls()).slice(before).filter((argv) => argv[7] === "tab").map((argv) => argv.slice(7))).toEqual([["tab", "list"]]);
  });

  it("blocks owner, paused, expired and obsolete leases without touching the page", async () => {
    const h = await setup();
    const request = await requestFor(h);
    const before = (await h.calls()).length;
    expect(await fill(h, { ...request, commandId: "stale_lease", generation: 1 })).toMatchObject({ status: "blocked", message: "paused" });
    await h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
    expect(await fill(h, { ...request, commandId: "owner_lease", generation: 3 })).toMatchObject({ status: "blocked", message: "owner has control" });
    await h.service.setControlLease({ holder: "paused", generation: 4, expiresAt: null });
    expect((await fill(h, { ...request, commandId: "paused_lease", generation: 4 })).status).toBe("blocked");
    await h.service.setControlLease({ holder: "agent", generation: 5, expiresAt: "2000-01-01T00:00:00.000Z" });
    expect((await fill(h, { ...request, commandId: "expired_lease", generation: 5 })).status).toBe("blocked");
    expect((await h.calls()).length).toBe(before);
    expect(inputs(h)).toEqual([]);
  });

  it("submits through CDP Enter events and permits the resulting navigation", async () => {
    const h = await setup();
    const request = await requestFor(h, { submit: true });
    h.cdp.onSend = (method) => {
      const last = h.cdp.calls.at(-1);
      if (method === "Input.dispatchKeyEvent" && last?.params.key === "Enter" && last.params.type === "keyDown") {
        h.cdp.event("Page.frameNavigated", { frame: { id: "frame_main" } }, "session_target_1");
      }
    };
    expect((await fill(h, request)).status).toBe("ok");
    expect(inputs(h).slice(-2).map((call) => call.params)).toEqual([
      { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" },
      { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    ]);
    expect((await h.calls()).some((argv) => argv[7] === "press")).toBe(false);
  });

  it("serializes secret fills with commands and shares duplicate detection while pending", async () => {
    const h = await setup();
    const request = await requestFor(h);
    const original = h.cdp.send.bind(h.cdp);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    h.cdp.send = async (method, params, sessionId) => {
      const result = await original(method, params, sessionId);
      if (method === "Runtime.callFunctionOn") await wait;
      return result;
    };
    const first = fill(h, request);
    await until(async () => inserts(h).length > 0);
    const duplicate = fill(h, request);
    const before = (await h.calls()).length;
    const second = h.command({ op: "tabs" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await h.calls()).length).toBe(before);
    release();
    expect(await first).toEqual(await duplicate);
    expect((await second).status).toBe("ok");
    expect(inserts(h)).toHaveLength(1);
  });

  it("kills the daemon after the takeover grace, aborts a stalled CDP fill and fences queued work", async () => {
    const clock = { ...systemClock, setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms === 10_000 ? 25 : ms === 1000 ? 3_600_000 : ms) };
    const h = await setup({ clock });
    const request = await requestFor(h, { submit: true });
    const pid = Number(await readFile(join(h.root, "daemon/quokkabot.pid"), "utf8"));
    const original = h.cdp.send.bind(h.cdp);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    h.cdp.send = async (method, params, sessionId) => {
      const result = await original(method, params, sessionId);
      if (method === "Runtime.callFunctionOn") await wait;
      return result;
    };
    const action = fill(h, request);
    await until(async () => inserts(h).length > 0);
    const transition = h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
    const queued = fill(h, { ...request, commandId: "queued_secret" });
    await transition;
    expect((await action).status).toBe("outcome_unknown");
    expect((await queued).status).toBe("blocked");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(h.cdp.connected).toBe(false);
    expect((await h.request("GET", `/v1/commands/${request.commandId}`)).body).toMatchObject({ status: "outcome_unknown" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(inputs(h).some((call) => call.params.key === "Enter")).toBe(false);
    await h.service.setControlLease({ holder: "agent", generation: 4, expiresAt: null });
    // Reconnect for graceful test shutdown. Production maintenance reconnects and rechecks readiness.
    await h.cdp.connect();
  });

  it("returns fixed errors for malformed bodies, CLI errors and CDP failures without leaking their contents", async () => {
    const h = await setup();
    const request = await requestFor(h);
    expect((await h.request("POST", "/v1/secret-fill", { ...request, kind: "unknown" })).body)
      .toEqual({ commandId: "invalid", status: "invalid", message: "invalid secret fill request" });
    h.cdp.failMethod = "Runtime.callFunctionOn";
    const result = await fill(h, request);
    expect(result).toEqual({ commandId: request.commandId, status: "outcome_unknown", message: "secret fill failed" });
    expect(JSON.stringify((await h.request("GET", `/v1/commands/${request.commandId}`)).body)).not.toContain("secret-canary");
    h.cdp.failMethod = undefined;
    await h.config({ reject: "focus" });
    expect(await fill(h, { ...request, commandId: "rejected_focus" })).toMatchObject({ status: "failed", message: "agent-browser rejected the command" });
  });
});
