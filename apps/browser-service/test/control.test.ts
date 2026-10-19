import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { systemClock } from "../src/runtime.js";
import { harness, until } from "./helpers.js";
import type { Harness } from "./helpers.js";

const instances: Harness[] = [];
async function setup(options?: Parameters<typeof harness>[0]) { const h = await harness(options); instances.push(h); return h; }
afterEach(async () => { for (const h of instances.splice(0)) await h.cleanup(); });

describe("control lease and command queue", () => {
  it("fences generations and owner/paused leases, clearing refs when control returns", async () => {
    const h = await setup();
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    expect((await h.command({ op: "tabs" }, 1))).toMatchObject({ status: "blocked", message: "paused" });
    await h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
    expect((await h.command({ op: "tabs" }, 3))).toMatchObject({ status: "blocked", message: "owner has control" });
    await h.service.setControlLease({ holder: "paused", generation: 4, expiresAt: null });
    expect((await h.command({ op: "tabs" }, 4))).toMatchObject({ status: "blocked", message: "paused" });
    await h.service.setControlLease({ holder: "agent", generation: 5, expiresAt: null });
    expect((await h.command({ op: "click", tab: "t1", snapshot: snapshot.snapshot, ref: "e1" }, 5)))
      .toMatchObject({ status: "invalid", message: "take a new snapshot" });
    const newer = await h.command({ op: "snapshot", tab: "t1" }, 5);
    expect(newer.snapshot).toBe(2);
    expect((await h.request("GET", "/v1/control-lease")).body).toEqual({ holder: "agent", generation: 5, expiresAt: null });
    await expect(h.service.setControlLease({ holder: "owner", generation: 4, expiresAt: null })).rejects.toThrow("generation must increase");
  });
  it("serializes concurrent commands and does not repeat a command id", async () => {
    const h = await setup();
    await h.command({ op: "snapshot", tab: "t1" });
    const first = h.command({ op: "type", tab: "t1", snapshot: 1, ref: "e1", text: "one" }, 2, "same_command");
    const duplicate = h.command({ op: "type", tab: "t1", snapshot: 1, ref: "e1", text: "one" }, 2, "same_command");
    const second = h.command({ op: "type", tab: "t1", snapshot: 1, ref: "e1", text: "two" });
    expect(await first).toEqual(await duplicate); expect((await second).status).toBe("ok");
    const calls = (await h.calls()).map((argv) => argv.slice(7)).filter((args) => args[0] === "fill");
    expect(calls).toEqual([["fill", "@e1", "one"], ["fill", "@e1", "two"]]);
    expect((await h.command({ op: "tabs" }, 2, "same_command")).status).toBe("invalid");
    expect((await h.request("GET", "/v1/commands/same_command")).body).toEqual(await first);
  });
  it("waits for a running command on lease change, then fences queued requests", async () => {
    const h = await setup({ timeoutMs: 800 });
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    await h.config({ hang: "fill" });
    const first = h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e1", text: "one" });
    await until(async () => (await h.calls()).some((args) => args[7] === "fill"));
    let leaseReturned = false;
    const lease = h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null }).then(() => { leaseReturned = true; });
    const queued = h.command({ op: "tabs" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(leaseReturned).toBe(false);
    expect((await first).status).toBe("outcome_unknown");
    await lease;
    expect((await queued).status).toBe("blocked");
  });
  it("kills a hanging daemon and joins its CLI before granting owner control, then gates the next daemon", async () => {
    const clock = { ...systemClock, setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms === 10_000 ? 25 : ms === 1000 ? 3_600_000 : ms) };
    const h = await setup({ clock, timeoutMs: 5000 });
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    const pid = Number(await readFile(join(h.root, "daemon/quokkabot.pid"), "utf8"));
    await h.config({ hang: "fill" });
    const original = h.runner.run;
    let cliExited = false;
    h.runner.run = async (executable, argv, options) => {
      try { return await original(executable, argv, options); }
      finally { if (argv[7] === "fill") cliExited = true; }
    };
    const action = h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e1", text: "one", submit: true });
    await until(async () => (await h.calls()).some((args) => args[7] === "fill"));
    await h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
    expect(cliExited).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await h.request("GET", "/v1/control-lease")).body).toMatchObject({ holder: "owner" });
    expect((await h.request("GET", "/health")).body).toMatchObject({ agentBrowserReady: false });
    expect((await action).status).toBe("outcome_unknown");
    expect((await h.calls()).filter((args) => args[7] === "fill")).toHaveLength(1);
    expect((await h.calls()).some((args) => args[7] === "press")).toBe(false);
    const before = (await h.calls()).length;
    await h.service.setControlLease({ holder: "agent", generation: 4, expiresAt: null });
    expect((await h.command({ op: "tabs" }, 4)).status).toBe("ok");
    const after = (await h.calls()).slice(before).map((args) => args.slice(7));
    expect(after.slice(0, 2)).toEqual([["stream", "disable"], ["stream", "status"]]);
    expect(Number(await readFile(join(h.root, "daemon/quokkabot.pid"), "utf8"))).not.toBe(pid);
  });
  it("retains exactly the last 500 results", async () => {
    const h = await setup();
    await h.service.setControlLease({ holder: "paused", generation: 3, expiresAt: null });
    for (let number = 0; number < 502; number++) await h.command({ op: "tabs" }, 3, `stored_${String(number).padStart(4, "0")}`);
    expect((await h.request("GET", "/v1/commands/stored_0000")).statusCode).toBe(404);
    expect((await h.request("GET", "/v1/commands/stored_0002")).statusCode).toBe(200);
    expect((await h.request("GET", "/v1/commands/stored_0501")).statusCode).toBe(200);
  });
  it("refuses takeover when the daemon pid cannot be trusted", async () => {
    const clock = { ...systemClock, setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms === 10_000 ? 25 : ms === 1000 ? 3_600_000 : ms) };
    const h = await setup({ clock, timeoutMs: 5000 });
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    await h.config({ hang: "fill" });
    const action = h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e1", text: "one" });
    await until(async () => (await h.calls()).some((args) => args[7] === "fill"));
    await writeFile(join(h.root, "daemon/quokkabot.pid"), "-1");
    expect(await h.request("PUT", "/v1/control-lease", { holder: "owner", generation: 3, expiresAt: null })).toEqual({
      statusCode: 409, body: { message: "cannot terminate agent-browser: invalid daemon pid" },
    });
    expect((await action).status).toBe("outcome_unknown");
    expect((await h.request("GET", "/v1/control-lease")).body).toMatchObject({ holder: "agent", generation: 2 });
  });
});

describe("agent-browser quirks seen on the real CLI", () => {
  it("is ready when the stream is already off, although disabling it again answers success:false", async () => {
    const h = await setup({ config: { enabled: false } });
    expect((await h.command({ op: "tabs" })).status).toBe("ok");
  });
  it("keeps refs on the active tab and asks for a new snapshot after a tab switch", async () => {
    const h = await setup();
    const first = await h.command({ op: "snapshot", tab: "t1" });
    expect((await h.command({ op: "click", tab: "t1", snapshot: first.snapshot, ref: "e1" })).status).toBe("ok");
    const opened = await h.command({ op: "open", url: "https://example.com/other" });
    expect(opened.status).toBe("ok");
    const stale = await h.command({ op: "click", tab: "t1", snapshot: first.snapshot, ref: "e1" });
    expect(stale).toMatchObject({ status: "invalid", message: "take a new snapshot" });
    const again = await h.command({ op: "snapshot", tab: "t1" });
    expect((await h.command({ op: "click", tab: "t1", snapshot: again.snapshot, ref: "e1" })).status).toBe("ok");
  });
});

describe("daemon stream safety and outcome uncertainty", () => {
  it("refuses commands until the daemon confirms streaming disabled", async () => {
    const h = await setup({ config: { enabled: true, disableWorks: false } });
    expect((await h.command({ op: "tabs" }))).toMatchObject({ status: "failed", message: "browser not ready" });
    expect((await h.calls()).some((argv) => argv[7] === "tab")).toBe(false);
    await h.config({ disableWorks: true });
    expect((await h.command({ op: "tabs" })).status).toBe("ok");
    expect((await h.request("GET", "/health")).body).toMatchObject({ agentBrowserReady: true });
  });
  it("disables and checks streaming again after a daemon restart and drops old refs", async () => {
    const h = await setup();
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    const before = (await h.calls()).length;
    await h.config({ enabled: true });
    await writeFile(join(h.root, "daemon/quokkabot.pid"), "restarted-pid");
    expect((await h.command({ op: "click", tab: "t1", snapshot: snapshot.snapshot, ref: "e1" })).status).toBe("invalid");
    const after = (await h.calls()).slice(before).map((argv) => argv.slice(7));
    expect(after[0]).toEqual(["stream", "disable"]); expect(after[1]).toEqual(["stream", "status"]);
    expect(after.some((args) => args[0] === "click")).toBe(false);
  });
  it.each(["hang", "crash", "malformed"])("returns outcome_unknown for a mutation and failed for a snapshot on %s", async (failure) => {
    const h = await setup({ timeoutMs: 800 });
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    await h.config({ [failure]: "fill" });
    const action = await h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e1", text: "value" });
    expect(action.status).toBe("outcome_unknown");
    expect(action.message).not.toContain("secret-canary");
    expect((await h.calls()).filter((argv) => argv[7] === "fill")).toHaveLength(1);
    await h.config({ [failure]: "snapshot" });
    expect((await h.command({ op: "snapshot", tab: "t1" })).status).toBe("failed");
  });
  it("treats a definite CLI rejection as failed and sanitizes its error text", async () => {
    const h = await setup();
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    await h.config({ reject: "fill" });
    expect((await h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e1", text: "value" })))
      .toMatchObject({ status: "failed", message: "agent-browser rejected the command" });
  });
  it("conservatively marks a mutating operation uncertain when its tab preparation process times out", async () => {
    const h = await setup({ timeoutMs: 800 });
    await h.config({ hang: "tab" });
    expect((await h.command({ op: "press", tab: "t1", key: "Enter" })).status).toBe("outcome_unknown");
    expect((await h.command({ op: "snapshot", tab: "t1" })).status).toBe("failed");
  });
});

describe("authenticated service endpoints", () => {
  it("rejects missing and wrong tokens for every route", async () => {
    const h = await setup();
    for (const path of ["/health", "/v1/commands", "/v1/secret-fill", "/v1/owner-focus?generation=3", "/v1/owner-fill", "/v1/control-lease", "/v1/downloads", "/v1/shutdown", "/v1/site-data/clear"]) {
      expect((await h.service.handle({ method: "GET", path })).statusCode).toBe(401);
      expect((await h.service.handle({ method: "POST", path, authorization: "Bearer wrong-token" })).statusCode).toBe(401);
    }
  });
  it("configures GUID downloads on each CDP connection and shuts Chrome down through Browser.close", async () => {
    const h = await setup();
    expect(h.cdp.calls[0]).toEqual({ method: "Browser.setDownloadBehavior", params: {
      behavior: "allowAndName", downloadPath: join(h.root, "staging"), eventsEnabled: true,
    } });
    expect((await h.request("POST", "/v1/shutdown")).statusCode).toBe(200);
    expect(h.cdp.calls.some((call) => call.method === "Browser.close")).toBe(true);
    expect((await h.request("GET", "/health")).body).toMatchObject({ chrome: "down", cdp: false, agentBrowserReady: false });
  });
  it("restarts an unexpectedly exited Chrome and reconfigures downloads and the stream gate", async () => {
    let tick: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = { ...systemClock, setTimeout(callback: () => void, ms: number) {
      if (ms === 1000) { tick = callback; timer = setTimeout(callback, 3_600_000); return timer; }
      return setTimeout(callback, ms);
    } };
    const h = await setup({ clock });
    h.chromeExit();
    await until(async () => (await h.request("GET", "/health")).body !== undefined && !h.cdp.connected);
    expect((await h.request("GET", "/health")).body).toMatchObject({ chrome: "down", cdp: false });
    if (timer !== undefined) clearTimeout(timer);
    expect(tick).toBeDefined(); tick!();
    await until(async () => ((await h.request("GET", "/health")).body as { agentBrowserReady: boolean }).agentBrowserReady);
    expect(h.starts).toHaveLength(2);
    expect(h.cdp.calls.filter((call) => call.method === "Browser.setDownloadBehavior")).toHaveLength(2);
    expect((await h.calls()).filter((args) => args[7] === "stream" && args[8] === "disable")).toHaveLength(2);
  });
});
