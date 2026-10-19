import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@quokkabot/shared";
import { AGENT_BROWSER_ARGV, CHROME_ARGV, chromeArgv } from "../src/runtime.js";
import { maskSnapshot } from "../src/snapshot.js";
import { harness, PNG } from "./helpers.js";
import type { Harness } from "./helpers.js";

const instances: Harness[] = [];
async function setup(options?: Parameters<typeof harness>[0]) { const instance = await harness(options); instances.push(instance); return instance; }
afterEach(async () => { for (const instance of instances.splice(0)) await instance.cleanup(); });

describe("fixed Chrome and agent-browser invocations", () => {
  it("permits internal attribute checks while keeping other extraction and executable actions denied", async () => {
    const policy = JSON.parse(await readFile(new URL("../agent-browser-policy.json", import.meta.url), "utf8")) as { default: string; allow: string[] };
    expect(policy.default).toBe("deny");
    expect(policy.allow).toContain("getattribute");
    for (const name of ["evaluate", "inputvalue", "innerhtml", "cookies_get", "storage_get", "read", "download", "upload", "waitforfunction", "stream_enable"]) {
      expect(policy.allow).not.toContain(name);
    }
  });
  it("keeps the complete Chrome sandbox and proxy launch template", async () => {
    expect(CHROME_ARGV).toEqual([
      "--user-data-dir=/config/chrome-profile", "--no-first-run", "--no-default-browser-check", "--start-maximized",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222", "--proxy-server=<QUOKKABOT_PROXY>",
      "--proxy-bypass-list=<-loopback>", "--disable-background-networking",
      "--disable-component-update", "--disable-features=BackForwardCache", "--disable-sync", "--password-store=basic", "--test-type",
    ]);
    expect(chromeArgv("http://egress:3128")).not.toContain("--no-sandbox");
    const h = await setup();
    expect(h.starts[0]?.argv).toEqual(chromeArgv("http://egress:3128"));
    expect(h.starts[0]?.env.DISPLAY).toBe(":1");
  });
  it("maps every operation to its fixed CLI form without dangerous commands", async () => {
    const h = await setup();
    expect((await h.command({ op: "tabs" })).tabs?.[0]?.tab).toBe("t1");
    expect((await h.command({ op: "activate", tab: "t1" })).status).toBe("ok");
    const snapshot = await h.command({ op: "snapshot", tab: "t1", interactiveOnly: true });
    const ref = { tab: "t1", snapshot: snapshot.snapshot, ref: "e1" };
    const operations = [
      { op: "type", ...ref, mode: "replace", text: "hello\nworld", submit: true },
      { op: "type", ...ref, mode: "append", text: "more" },
      { op: "select", ...ref, option: "An option\nwith a newline" },
      { op: "check", ...ref, checked: true }, { op: "check", ...ref, checked: false },
      { op: "press", tab: "t1", key: "ArrowDown" },
      { op: "scroll", tab: "t1", direction: "down", amount: "page" },
      { op: "scroll", tab: "t1", direction: "left", amount: "half" },
      { op: "scroll", tab: "t1", direction: "up", amount: "line" },
      { op: "wait", tab: "t1", until: { kind: "text", text: "Ready\nnow" }, timeoutS: 3 },
      { op: "wait", tab: "t1", until: { kind: "text_gone", text: 'Loading "quoted"' }, timeoutS: 3 },
      { op: "wait", tab: "t1", until: { kind: "url_contains", value: "/account" }, timeoutS: 3 },
      { op: "wait", tab: "t1", until: { kind: "load" }, timeoutS: 3 },
      { op: "wait", tab: "t1", until: { kind: "network_idle" }, timeoutS: 3 },
      { op: "screenshot", tab: "t1" }, { op: "click", ...ref },
    ];
    for (const operation of operations) expect((await h.command(operation)).status, JSON.stringify(operation)).toBe("ok");
    for (const op of ["back", "forward", "reload"]) expect((await h.command({ op, tab: "t1" })).status).toBe("ok");
    expect((await h.command({ op: "navigate", tab: "t1", url: "https://example.org/new" })).url).toBe("https://example.org/new");
    expect((await h.command({ op: "open", url: "https://example.net/" })).tab).toBe("t2");
    expect((await h.command({ op: "close", tab: "t2" })).status).toBe("ok");
    const calls = await h.calls();
    for (const argv of calls) expect(argv.slice(0, 7)).toEqual(AGENT_BROWSER_ARGV);
    const commands = calls.map((argv) => argv.slice(7));
    for (const expected of [
      ["snapshot", "-i"], ["fill", "@e1", "hello\nworld"], ["type", "@e1", "more"], ["press", "Enter"],
      ["select", "@e1", "An option\nwith a newline"], ["check", "@e1"], ["uncheck", "@e1"],
      ["press", "ArrowDown"], ["scroll", "down", "800"], ["scroll", "left", "400"], ["scroll", "up", "40"],
      ["wait", "--text", "Ready\nnow", "--timeout", "3000"],
      ["wait", 'text="Loading \\"quoted\\""', "--state", "hidden", "--timeout", "3000"],
      ["wait", "--url", "**/account**", "--timeout", "3000"], ["wait", "--load", "load", "--timeout", "3000"],
      ["wait", "--load", "networkidle", "--timeout", "3000"], ["click", "@e1"],
      ["back"], ["forward"], ["reload"], ["open", "https://example.org/new"],
      ["tab", "new", "https://example.net/"], ["tab", "close", "target_2"],
    ]) expect(commands).toContainEqual(expected);
    expect(commands.filter((command) => command[0] === "get")).toEqual([
      ["get", "attr", "@e1", "type"], ["get", "attr", "@e1", "autocomplete"],
      ["get", "attr", "@e1", "type"], ["get", "attr", "@e1", "autocomplete"],
    ]);
    const forbidden = new Set(["eval", "cookies", "storage", "download", "upload", "connect", "mcp", "chat", "network"]);
    expect(commands.some((command) => forbidden.has(command[0]!) || command[0] === "stream" && command[1] === "enable")).toBe(false);
    expect(commands.find((command) => command[0] === "screenshot")?.slice(2)).toEqual(["--screenshot-format", "png"]);
  });
  it("rejects flag-shaped inputs before spawning and preserves embedded newlines as a single operand", async () => {
    const h = await setup();
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    const base = { tab: "t1", snapshot: snapshot.snapshot, ref: "e1" };
    for (const text of ["--cdp=1", "-x", "--", "\0"]) {
      const before = (await h.calls()).length;
      expect((await h.command({ op: "type", ...base, text })).status).toBe("invalid");
      expect((await h.command({ op: "select", ...base, option: text })).status).toBe("invalid");
      expect((await h.command({ op: "wait", tab: "t1", until: { kind: "text", text } })).status).toBe("invalid");
      expect((await h.calls()).length).toBe(before);
    }
    const text = "first\n--cdp=1\nlast";
    expect((await h.command({ op: "type", ...base, text })).status).toBe("ok");
    expect((await h.calls()).map((argv) => argv.slice(7))).toContainEqual(["fill", "@e1", text]);
    for (const op of [{ op: "press", tab: "t1", key: "Control+a" }, { op: "open", url: "file:///etc/passwd" }, { op: "eval", script: "1" }, { op: "get", ref: "e1", attribute: "value" }]) {
      expect((await h.command(op)).status).toBe("invalid");
    }
  });
});

describe("snapshots and opaque references", () => {
  it("hides every text-entry value and its descendants while preserving names and usable refs", async () => {
    const fields = [
      ['textbox', 'Secret', 'password-canary', 'e1'],
      ['textbox', 'Code', 'code-canary', 'e2'],
      ['searchbox', 'Search', 'search-canary', 'e3'],
      ['spinbutton', 'Quantity', 'quantity-canary', 'e4'],
      ['combobox', 'Destination', 'combo-canary', 'e5'],
    ];
    const h = await setup({ config: {
      snapshot: fields.map(([role, name, value, ref]) => `- ${role} "${name}" [ref=${ref}]: ${value}\n  - StaticText "child-${value}"`).join("\n") + '\n- textbox [ref=e6]',
      refs: Object.fromEntries([...fields.map(([role, name, _value, ref]) => [ref, { role, name }]), ["e6", { role: "textbox" }]]),
      attributes: { e1: { type: "password" }, e2: { type: "text", autocomplete: "one-time-code" } },
    } });
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    expect(snapshot.status).toBe("ok");
    for (const [role, name, value, ref] of fields) {
      expect(snapshot.text).toContain(`- ${role} "${name}" [ref=${ref}]: [hidden]`);
      expect(snapshot.text).not.toContain(value);
    }
    expect(snapshot.text).toContain('- textbox [ref=e6]: [hidden]');
    expect(snapshot.text).not.toContain("StaticText");
    for (const ref of ["e1", "e2"]) {
      expect((await h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref, text: "owner-only" })).status).toBe("blocked");
    }
    for (const ref of ["e3", "e4", "e5", "e6"]) {
      expect((await h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref, text: "allowed" })).status).toBe("ok");
    }
  });
  it("masks bullet length, visible passwords and repeated child values before pagination", async () => {
    const h = await setup({ config: { snapshot:
      '- textbox "Email" [ref=e1]: ok\n- textbox "Secret" [ref=e2]: •••••••••\n  - StaticText "•••••••••"\n' +
      '- textbox "Show password" [ref=e3]: cleartext-canary\n  - StaticText "cleartext-canary"\n' +
      '- textbox "One-time code" [ref=e4]: 987654\n- textbox "PIN" [ref=e5]: 1234\n' + "- paragraph " + "a".repeat(LIMITS.snapshotPageChars + 50),
    } });
    const first = await h.command({ op: "snapshot", tab: "t1" });
    const second = await h.command({ op: "snapshot", tab: "t1", page: 2 });
    expect(first.pages).toBe(2); expect(first.text?.length).toBe(LIMITS.snapshotPageChars);
    expect(second.snapshot).toBe(first.snapshot);
    const combined = first.text! + second.text!;
    expect(combined).toContain('[ref=e3]: [hidden]');
    for (const secret of ["•", "cleartext-canary", "987654", "1234", "StaticText"]) expect(combined).not.toContain(secret);
    expect((await h.calls()).filter((argv) => argv[7] === "snapshot")).toHaveLength(1);
    for (const ref of ["e2", "e3", "e4", "e5"]) {
      const typed = await h.command({ op: "type", tab: "t1", snapshot: first.snapshot, ref, text: "secret" });
      expect(typed.status).toBe("blocked");
      expect(typed.message).toBe("password and code fields are typed from saved logins with browser_fill_login and browser_fill_code");
    }
  });
  it("rejects stale generations and unknown refs without sending input", async () => {
    const h = await setup();
    const first = await h.command({ op: "snapshot", tab: "t1" });
    const second = await h.command({ op: "snapshot", tab: "t1" });
    expect(second.snapshot).toBe(2);
    for (const ref of [
      { snapshot: first.snapshot, ref: "e1" }, { snapshot: second.snapshot, ref: "e999" },
    ]) {
      const result = await h.command({ op: "click", tab: "t1", ...ref });
      expect(result).toMatchObject({ status: "invalid", message: "take a new snapshot" });
    }
    expect((await h.calls()).some((argv) => argv[7] === "click")).toBe(false);
  });
  it("keeps tab refs stable across daemon id changes and never reuses a closed tab ref", async () => {
    const h = await setup();
    await h.command({ op: "tabs" });
    await h.config({ tabs: [{ tabId: "t9", targetId: "target_1", title: "Same", url: "https://example.com/", active: true }] });
    await writeFile(join(h.root, "daemon/quokkabot.pid"), "2000");
    expect((await h.command({ op: "tabs" })).tabs?.[0]?.tab).toBe("t1");
    await h.command({ op: "close", tab: "t1" });
    const opened = await h.command({ op: "open", url: "https://new.example.com/" });
    expect(opened.tab).toBe("t2");
  });
  it("downscales oversized viewport screenshots as PNG through CDP", async () => {
    const h = await setup({ config: { largeScreenshot: true } });
    const shot = await h.command({ op: "screenshot", tab: "t1" });
    expect(shot.status).toBe("ok"); expect(Buffer.from(shot.pngBase64!, "base64")).toEqual(PNG);
    expect(h.cdp.calls.find((call) => call.method === "Page.captureScreenshot")?.params).toMatchObject({ format: "png", captureBeyondViewport: false, clip: { scale: 0.75, width: 1280, height: 800 } });
  });
  it("masks password-like names without requiring a value", () => {
    const result = maskSnapshot('- textbox "CVC" [ref=e4]\n- textbox "verification code" [ref=e5]: visible');
    expect([...result.passwords]).toEqual(["e4", "e5"]);
    expect(result.text).not.toContain("visible");
  });
  it("removes multiline sensitive values even without a ref or value delimiter", () => {
    const result = maskSnapshot('- textbox "Password": first-secret\nsecond-secret\n\n  - StaticText "third-secret"\n- textbox "Email" [ref=e1]: address');
    expect(result.text).toBe('- textbox "Password": [hidden]\n- textbox "Email" [ref=e1]: [hidden]');
  });
  it("invalidates refs on same-URL document navigation reported by CDP", async () => {
    const h = await setup();
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    h.cdp.event("Page.frameNavigated", { frame: { id: "frame1", url: "https://example.com/" } }, "session_target_1");
    expect(await h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e1", text: "value" }))
      .toMatchObject({ status: "invalid", message: "take a new snapshot" });
    expect((await h.calls()).some((args) => args[7] === "fill")).toBe(false);
  });
  it("does not authorize ref-looking page text and uses structured metadata for password checks", async () => {
    const h = await setup({ config: {
      snapshot: '- textbox "Name [ref=e999]" [ref=e1]: ••••',
      refs: { e1: { role: "textbox", name: "Name [ref=e999]" } },
    } });
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    expect(snapshot.status).toBe("ok");
    expect(await h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e999", text: "value" }))
      .toMatchObject({ status: "invalid", message: "take a new snapshot" });
    expect((await h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e1", text: "value" })).status).toBe("blocked");
  });
});

describe("service-side sensitive-field checks", () => {
  it.each([
    { type: "password" },
    { type: "text", autocomplete: "one-time-code" },
    ...["current-password", "new-password", "cc-number", "cc-csc", "cc-exp", "cc-exp-month"].map((autocomplete) => ({ type: "text", autocomplete: `section-payment ${autocomplete}` })),
    { type: "PASSWORD" },
    { autocomplete: "ONE-TIME-CODE" },
  ])("blocks empty fields with an unrecognised label and attributes %j", async (attributes) => {
    const h = await setup({ config: { snapshot: '- textbox "Secret" [ref=e1]', attributes: { e1: attributes } } });
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    expect(await h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e1", text: "canary", submit: true }))
      .toMatchObject({ status: "blocked", message: "password and code fields are typed from saved logins with browser_fill_login and browser_fill_code" });
    const calls = (await h.calls()).map((args) => args.slice(7));
    expect(calls.slice(-2)).toEqual([["get", "attr", "@e1", "type"], ["get", "attr", "@e1", "autocomplete"]]);
    expect(calls.some((args) => ["fill", "type", "press"].includes(args[0]!))).toBe(false);
  });

  it("rechecks both attributes before every type, including changes after the snapshot", async () => {
    const h = await setup({ config: { attributes: { e1: { type: "text", autocomplete: "email" } } } });
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    const op = { op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e1", text: "plain" };
    expect((await h.command(op)).status).toBe("ok");
    expect((await h.command({ ...op, mode: "append" })).status).toBe("ok");
    await h.config({ attributes: { e1: { type: "text", autocomplete: "one-time-code" } } });
    expect((await h.command(op)).status).toBe("blocked");
    expect((await h.calls()).map((args) => args.slice(7)).filter((args) => args[0] !== "tab").slice(-8)).toEqual([
      ["get", "attr", "@e1", "type"], ["get", "attr", "@e1", "autocomplete"], ["fill", "@e1", "plain"],
      ["get", "attr", "@e1", "type"], ["get", "attr", "@e1", "autocomplete"], ["type", "@e1", "plain"],
      ["get", "attr", "@e1", "type"], ["get", "attr", "@e1", "autocomplete"],
    ]);
  });

  it("sends no input if an attribute read fails", async () => {
    const h = await setup();
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    await h.config({ reject: "get" });
    expect((await h.command({ op: "type", tab: "t1", snapshot: snapshot.snapshot, ref: "e1", text: "canary" })).status).toBe("failed");
    expect((await h.calls()).some((args) => args[7] === "fill")).toBe(false);
  });
});
