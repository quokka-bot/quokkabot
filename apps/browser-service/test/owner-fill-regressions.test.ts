import { afterEach, describe, expect, it } from "vitest";
import { BrowserCommandRequest } from "@quokkabot/shared";
import type { BrowserCommandResult } from "@quokkabot/shared";
import { CDP_COMMAND_TIMEOUT_MS, OWNER_INSERTION_WINDOW_MS } from "../src/cdp.js";
import { systemClock } from "../src/runtime.js";
import { harness, RUN_ID, until } from "./helpers.js";
import type { Harness } from "./helpers.js";

const instances: Harness[] = [];
afterEach(async () => { for (const h of instances.splice(0)) await h.cleanup(); });
async function setup(options?: Parameters<typeof harness>[0]) {
  const h = await harness(options); instances.push(h);
  await h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
  return h;
}
async function inspect(h: Harness) {
  const response = await h.request("GET", "/v1/owner-focus?generation=3");
  return (response.body as { field: { origin: string; kind: string; focusId: string } | null }).field;
}
async function payload(h: Harness) {
  const field = await inspect(h);
  expect(field).not.toBeNull();
  return { commandId: "regression_fill", leaseGeneration: 3, kind: field!.kind, value: "826491", submit: false,
    focusId: field!.focusId };
}
async function fill(h: Harness, body: unknown) {
  return (await h.request("POST", "/v1/owner-fill", body)).body as BrowserCommandResult;
}

describe("owner fill review regressions", () => {
  it("issues a random opaque focus handle", async () => {
    const h = await setup();
    const first = await inspect(h), second = await inspect(h);
    expect(first?.focusId).toMatch(/^[a-f0-9]{64}$/);
    expect(second?.focusId).not.toBe(first?.focusId);
  });

  it.each(["replacement", "same origin navigation", "new lease", "hidden", "inert", "zero box", "hidden document", "offscreen", "other tab", "other frame"])("refuses the inspected field after %s", async (change) => {
    const h = await setup();
    const body = await payload(h);
    const frame = h.cdp.frames[0]!;
    if (change === "replacement") frame.field = { ...frame.field! };
    if (change === "same origin navigation") h.cdp.event("Page.frameNavigated", { frame: { id: frame.id } }, "session_target_1");
    if (change === "new lease") {
      await h.service.setControlLease({ holder: "agent", generation: 4, expiresAt: null });
      await h.service.setControlLease({ holder: "owner", generation: 5, expiresAt: null });
      body.leaseGeneration = 5;
    }
    if (change === "hidden") frame.hidden = true;
    if (change === "inert") frame.inert = true;
    if (change === "zero box") frame.zeroBox = true;
    if (change === "hidden document") frame.documentHidden = true;
    if (change === "offscreen") frame.offscreen = true;
    if (change === "other tab" || change === "other frame") {
      const spec = frame.field;
      frame.field = null;
      if (change === "other tab") h.cdp.targets.push({ targetId: "target_2", type: "page", url: "https://example.com/" });
      h.cdp.frames.push({ id: "other_field", origin: frame.origin, parentId: change === "other frame" ? frame.id : null,
        pageTarget: change === "other tab" ? "target_2" : "target_1", field: spec });
    }
    expect((await fill(h, body)).status).toBe("blocked");
    expect(h.cdp.frames.every((frame) => frame.inserted === undefined)).toBe(true);
  });

  it.each([
    { type: "search", autocomplete: "one-time-code", hints: "code" },
    ...["text", "number", "tel"].map((type) => ({ type, inputMode: "numeric", hints: "" })),
    ...["zip code", "postal code", "post code", "phone verification", "zipCode", "postalCode", "post_code", "phoneNumber"].map((hints) => ({ type: "tel", autocomplete: "one-time-code", hints })),
  ])("refuses code field impostors %j", async (attrs) => {
    const h = await setup();
    Object.assign(h.cdp.frames[0]!.field!, { autocomplete: "", ...attrs });
    expect(await inspect(h)).toBeNull();
  });

  it("refuses snapshots of an owner code echoed outside its input after hand-back", async () => {
    const h = await setup();
    const frame = h.cdp.frames[0]!;
    Object.assign(frame.field!, { type: "text", autocomplete: "one-time-code" });
    frame.echoInput = true;
    const body = await payload(h);
    expect((await fill(h, body)).status).toBe("ok");
    expect(frame.echo).toBe(`You entered ${body.value}`);
    await h.config({ snapshot: `- textbox "Code" [ref=e1]: ${body.value}\n- paragraph: ${frame.echo}` });
    await h.service.setControlLease({ holder: "agent", generation: 4, expiresAt: null });
    const result = await h.command({ op: "snapshot", tab: "t1" }, 4);
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("load another page first");
    expect(JSON.stringify(result)).not.toContain(body.value);
    expect((await h.calls()).some((argv) => argv[7] === "snapshot")).toBe(false);
  });

  it("disables bfcache and refuses both observations after fill, navigate, Back", async () => {
    const h = await setup();
    expect((await fill(h, await payload(h))).status).toBe("ok");
    await h.service.setControlLease({ holder: "agent", generation: 4, expiresAt: null });
    await h.command({ op: "navigate", tab: "t1", url: "https://example.com/next" }, 4);
    h.cdp.event("Page.frameNavigated", { frame: { id: "frame_main", loaderId: "next_document" }, type: "Navigation" }, "session_target_1");
    expect((await h.command({ op: "snapshot", tab: "t1" }, 4)).status).toBe("ok");
    await h.command({ op: "back", tab: "t1" }, 4);
    h.cdp.event("Page.frameNavigated", { frame: { id: "frame_main", loaderId: "old_document" }, type: "BackForwardCacheRestore" }, "session_target_1");
    for (const op of ["screenshot", "snapshot"]) expect((await h.command({ op, tab: "t1" }, 4)).status).toBe("blocked");
    const disabled = h.starts[0]!.argv.filter((arg) => arg.startsWith("--disable-features="));
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.split(/[=,]/)).toContain("BackForwardCache");
  });

  it("never executes an insertion delayed beyond the CDP timeout under the next lease", async () => {
    const h = await setup();
    const body = { ...await payload(h), submit: true };
    expect(OWNER_INSERTION_WINDOW_MS).toBeLessThan(CDP_COMMAND_TIMEOUT_MS);
    const original = h.cdp.send.bind(h.cdp);
    let executeLate: (() => Promise<unknown>) | undefined;
    h.cdp.send = async (method, params, sessionId) => {
      if (method === "Runtime.callFunctionOn" && String(params?.functionDeclaration).includes("insertText")) {
        executeLate = () => original(method, params, sessionId);
        // Start the same timeout as the real CDP transport, without executing anything in the page yet.
        return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("CDP Runtime.callFunctionOn timed out")), CDP_COMMAND_TIMEOUT_MS));
      }
      if (method === "Runtime.releaseObject" && executeLate) return {};
      return original(method, params, sessionId);
    };
    const action = fill(h, body);
    await until(async () => executeLate !== undefined);
    await h.service.setControlLease({ holder: "agent", generation: 4, expiresAt: null });
    expect((await action).status).toBe("outcome_unknown");
    expect(await executeLate!()).toMatchObject({ result: { value: "expired insertion" } });
    expect(h.cdp.frames[0]!.inserted).toBeUndefined();
    expect(h.cdp.calls.some((call) => call.method.startsWith("Input."))).toBe(false);
  });

  it.each(["expired", "used", "wrong kind"])("refuses a %s handle without another inspection", async (state) => {
    let now = new Date();
    const h = await setup({ clock: { ...systemClock, now: () => now } });
    const body = await payload(h);
    if (state === "expired") now = new Date(now.getTime() + 60_000);
    if (state === "used") expect((await fill(h, body)).status).toBe("ok");
    if (state === "wrong kind") expect((await fill(h, { ...body, kind: "code" })).status).toBe("blocked");
    const before = h.cdp.calls.length;
    expect((await fill(h, { ...body, commandId: "second_fill" })).status).toBe("blocked");
    expect(h.cdp.calls.slice(before).some((call) => call.method === "Runtime.evaluate" || call.method === "Runtime.callFunctionOn")).toBe(false);
  });

  it.each(["name", "id", "placeholder", "ariaLabel"])("uses the %s code hint at inspection and insertion", async (hint) => {
    const h = await setup();
    Object.assign(h.cdp.frames[0]!.field!, { type: "text", autocomplete: "", hints: "", [hint]: "Verification code" });
    const body = await payload(h);
    expect(body.kind).toBe("code");
    expect((await fill(h, body)).status).toBe("ok");
  });

  it.each(["search", "zip", "postal", "post code", "phone", "numeric only"])("rechecks the code rule at insertion after changing to %s", async (hint) => {
    const h = await setup();
    const spec = h.cdp.frames[0]!.field!;
    Object.assign(spec, { type: "text", autocomplete: "one-time-code", hints: "" });
    const body = await payload(h);
    if (hint === "search") spec.type = "search";
    else if (hint === "numeric only") Object.assign(spec, { autocomplete: "", inputMode: "numeric" });
    else spec.hints = hint;
    expect((await fill(h, body)).status).toBe("blocked");
    expect(h.cdp.frames[0]!.inserted).toBeUndefined();
  });

  it("expires a dispatched insertion at the lease deadline inside the page", async () => {
    let now = new Date();
    const h = await setup({ clock: { ...systemClock, now: () => now } });
    await h.service.setControlLease({ holder: "owner", generation: 4, expiresAt: new Date(now.getTime() + 1000).toISOString() });
    const focused = await h.request("GET", "/v1/owner-focus?generation=4");
    const focusId = (focused.body as { field: { focusId: string } }).field.focusId;
    now = new Date(now.getTime() + 900);
    const original = h.cdp.send.bind(h.cdp);
    let browserOutcome: unknown;
    h.cdp.send = async (method, params, sessionId) => {
      if (method === "Runtime.callFunctionOn" && String(params?.functionDeclaration).includes("insertText")) {
        const deadline = Number((params!.arguments as { value: unknown }[])[5]!.value);
        expect(deadline - Date.now()).toBeLessThanOrEqual(100);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 20));
        now = new Date(now.getTime() + 200);
        browserOutcome = await original(method, params, sessionId);
        return browserOutcome;
      }
      return original(method, params, sessionId);
    };
    expect((await fill(h, { commandId: "expired_dispatch", leaseGeneration: 4, focusId, kind: "password", value: "826491", submit: true })).status).toBe("blocked");
    expect(browserOutcome).toMatchObject({ result: { value: "expired insertion" } });
    expect(h.cdp.frames[0]!.inserted).toBeUndefined();
    expect(h.cdp.calls.some((call) => call.method.startsWith("Input."))).toBe(false);
  });

  it("keeps the lease fence until the deadline after an early transport rejection", async () => {
    const h = await setup();
    const body = await payload(h);
    const original = h.cdp.send.bind(h.cdp);
    let deadline = 0;
    h.cdp.send = async (method, params, sessionId) => {
      if (method === "Runtime.callFunctionOn" && String(params?.functionDeclaration).includes("insertText")) {
        deadline = Number((params!.arguments as { value: unknown }[])[5]!.value);
        throw new Error("connection closed before execution");
      }
      return original(method, params, sessionId);
    };
    const action = fill(h, body);
    await until(async () => deadline !== 0);
    let changed = false;
    const transition = h.service.setControlLease({ holder: "agent", generation: 4, expiresAt: null }).then(() => { changed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changed).toBe(false);
    await transition;
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    expect((await action).status).toBe("outcome_unknown");
  });

  it("keeps the lease fence until a reply that arrives after the deadline and sends no late Enter", async () => {
    const h = await setup();
    const body = { ...await payload(h), submit: true };
    const original = h.cdp.send.bind(h.cdp);
    let deadline = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    h.cdp.send = async (method, params, sessionId) => {
      const result = await original(method, params, sessionId);
      if (method === "Runtime.callFunctionOn" && String(params?.functionDeclaration).includes("insertText")) {
        deadline = Number((params!.arguments as { value: unknown }[])[5]!.value);
        await wait;
      }
      return result;
    };
    const action = fill(h, body);
    await until(async () => deadline !== 0);
    let changed = false;
    const transition = h.service.setControlLease({ holder: "agent", generation: 4, expiresAt: null }).then(() => { changed = true; });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 30));
    expect(changed).toBe(false);
    release();
    await transition;
    expect((await action).status).toBe("outcome_unknown");
    expect(h.cdp.calls.some((call) => call.method.startsWith("Input."))).toBe(false);
  });

  it.each(["owner-fill", "owner-focus"])("rejects %s in an otherwise valid command envelope", async (op) => {
    const h = await setup();
    const envelope = { commandId: "valid_command_id", runId: RUN_ID, generation: 3, op: { op: "tabs" } };
    expect(BrowserCommandRequest.safeParse(envelope).success).toBe(true);
    expect((await h.request("POST", "/v1/commands", { ...envelope, op: { op } })).body).toMatchObject({ status: "invalid" });
  });
});
