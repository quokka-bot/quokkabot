import { describe, expect, it } from "vitest";
import {
  AUDIT_GENESIS_HASH,
  type AuditEvent,
  BrowserOp,
  DomainPattern,
  Hostname,
  HttpUrl,
  MCP_TOOLS,
  REACTION_EMOJIS,
  ReactionRequest,
  TaskEvent,
  RelPath,
  hostMatchesPattern,
} from "../src/index.js";
import { auditHash, verifyAuditChain } from "../src/node.js";

describe("HttpUrl", () => {
  it.each(["https://example.com/", "http://billing.example.com/invoices?x=1"])("accepts %s", (url) => {
    expect(HttpUrl.safeParse(url).success).toBe(true);
  });
  it.each([
    "file:///etc/passwd",
    "chrome://settings",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:pass@example.com/",
    "ftp://example.com/",
    "about:blank",
    "--remote-debugging-port=1",
  ])("refuses %s", (url) => {
    expect(HttpUrl.safeParse(url).success).toBe(false);
  });
});

describe("RelPath", () => {
  it.each(["", "invoices/2026-10.pdf", "a/b/c.txt"])("accepts %s", (p) => {
    expect(RelPath.safeParse(p).success).toBe(true);
  });
  it.each(["/etc/passwd", "../x", "a/../../b", "a//b", "a/./b", "-rf", "a\\b", "a\0b"])("refuses %s", (p) => {
    expect(RelPath.safeParse(p).success).toBe(false);
  });
});

describe("Hostname and DomainPattern", () => {
  it("normalises case and a trailing dot", () => {
    expect(Hostname.parse("Billing.Example.COM.")).toBe("billing.example.com");
  });
  it.each(["localhost", "127.0.0.1", "-a.example.com", "exa mple.com", "*.example.com"])("hostname refuses %s", (h) => {
    expect(Hostname.safeParse(h).success).toBe(false);
  });
  it("patterns allow one leading wildcard", () => {
    expect(DomainPattern.parse("*.Stripe.com")).toBe("*.stripe.com");
    expect(DomainPattern.safeParse("a.*.com").success).toBe(false);
    expect(DomainPattern.safeParse("*").success).toBe(false);
    expect(DomainPattern.safeParse("*.0.0.1").success).toBe(false);
  });
  it("wildcards match the base and subdomains only", () => {
    expect(hostMatchesPattern("stripe.com", "*.stripe.com")).toBe(true);
    expect(hostMatchesPattern("pay.stripe.com", "*.stripe.com")).toBe(true);
    expect(hostMatchesPattern("evilstripe.com", "*.stripe.com")).toBe(false);
    expect(hostMatchesPattern("stripe.com.evil.io", "*.stripe.com")).toBe(false);
    expect(hostMatchesPattern("pay.stripe.com", "stripe.com")).toBe(false);
  });
});

describe("browser operations", () => {
  it("refuses unknown properties and option-like refs", () => {
    expect(BrowserOp.safeParse({ op: "click", tab: "t1", snapshot: 3, ref: "e4", force: true }).success).toBe(false);
    expect(BrowserOp.safeParse({ op: "click", tab: "--cdp", snapshot: 3, ref: "e4" }).success).toBe(false);
    expect(BrowserOp.safeParse({ op: "click", tab: "t1", snapshot: 3, ref: "#login" }).success).toBe(false);
    expect(BrowserOp.safeParse({ op: "eval", tab: "t1", code: "1" }).success).toBe(false);
  });
  it("refuses key chords and JavaScript waits", () => {
    expect(BrowserOp.safeParse({ op: "press", tab: "t1", key: "Control+v" }).success).toBe(false);
    expect(
      BrowserOp.safeParse({ op: "wait", tab: "t1", until: { kind: "function", code: "true" } }).success,
    ).toBe(false);
  });
});

describe("MCP tools", () => {
  it("are strict", () => {
    expect(MCP_TOOLS.workspace_exec.input.safeParse({ command: "ls", extra: 1 }).success).toBe(false);
    expect(MCP_TOOLS.browser_tabs.input.safeParse({}).success).toBe(true);
  });
  it("offer no eval, cookie, storage or upload tool", () => {
    const names = Object.keys(MCP_TOOLS).join(",");
    expect(names).not.toMatch(/eval|cookie|storage|upload|cdp|clipboard/);
  });
});

describe("message reaction contracts", () => {
  it.each([...REACTION_EMOJIS, null])("accepts %s for owner, agent and stream reactions", (emoji) => {
    expect(ReactionRequest.parse({ emoji })).toEqual({ emoji });
    expect(MCP_TOOLS.react.input.parse({ emoji })).toEqual({ emoji });
    for (const by of ["owner", "agent"] as const) {
      expect(TaskEvent.parse({ kind: "reaction", targetSeq: 4, by, emoji })).toEqual({ kind: "reaction", targetSeq: 4, by, emoji });
    }
  });
  it.each([{}, { emoji: "💥" }, { emoji: "👍", by: "agent" }])("rejects invalid reaction input %j", (input) => {
    expect(ReactionRequest.safeParse(input).success).toBe(false);
    expect(MCP_TOOLS.react.input.safeParse(input).success).toBe(false);
  });
  it("rejects invalid event targets and actors", () => {
    expect(TaskEvent.safeParse({ kind: "reaction", targetSeq: 0, by: "owner", emoji: "👍" }).success).toBe(false);
    expect(TaskEvent.safeParse({ kind: "reaction", targetSeq: 1.5, by: "agent", emoji: "👍" }).success).toBe(false);
    expect(TaskEvent.safeParse({ kind: "reaction", targetSeq: 1, by: "system", emoji: "👍" }).success).toBe(false);
  });
});

function chain(count: number): AuditEvent[] {
  const events: AuditEvent[] = [];
  let prev = AUDIT_GENESIS_HASH;
  for (let seq = 1; seq <= count; seq += 1) {
    const base = {
      agentId: "6f1c1d2e-8f4b-4c55-9a59-0d7a7f6f3a10" as AuditEvent["agentId"],
      seq,
      at: `2026-10-17T10:00:0${seq}Z`,
      actor: "system" as const,
      type: "computer.started" as const,
      data: { n: seq, nested: { b: 2, a: 1 } },
      prevHash: prev,
    };
    const hash = auditHash(base);
    events.push({ ...base, hash });
    prev = hash;
  }
  return events;
}

describe("audit chain", () => {
  it("verifies an intact chain and its head", () => {
    const events = chain(4);
    const result = verifyAuditChain(events, events[3]?.hash);
    expect(result.ok).toBe(true);
  });
  it("detects an edited event", () => {
    const events = chain(4);
    const edited = events.map((e) => (e.seq === 2 ? { ...e, data: { n: 99 } } : e));
    expect(verifyAuditChain(edited)).toMatchObject({ ok: false, failedAtSeq: 2 });
  });
  it("detects a deleted event", () => {
    const events = chain(4).filter((e) => e.seq !== 3);
    expect(verifyAuditChain(events)).toMatchObject({ ok: false, failedAtSeq: 4 });
  });
  it("detects reordering", () => {
    const events = chain(3);
    const [a, b, c] = events as [AuditEvent, AuditEvent, AuditEvent];
    expect(verifyAuditChain([a, c, b]).ok).toBe(false);
  });
  it("detects a truncated tail against a saved checkpoint", () => {
    const events = chain(4);
    expect(verifyAuditChain(events.slice(0, 3), events[3]?.hash)).toMatchObject({ ok: false });
  });
  it("hashes independently of key order", () => {
    const [first] = chain(1) as [AuditEvent];
    const { hash, ...rest } = first;
    const reordered = { ...rest, data: { nested: { a: 1, b: 2 }, n: 1 } };
    expect(auditHash(reordered)).toBe(hash);
  });
});

describe("old owner message events", () => {
  it("defaults missing image metadata to an empty list", () => {
    expect(TaskEvent.parse({ kind: "owner_message", text: "before images" })).toEqual({ kind: "owner_message", text: "before images", attachments: [] });
  });
});
