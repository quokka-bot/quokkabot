import { describe, expect, it } from "vitest";
import { askedLine, chatItems, describeStep, sitesLine, timeLabel, workingStatus } from "../src/index.js";
import { at, attachment, domainRequestId, envelopes, ownerRequest, run, taskId } from "./fixtures.js";

it("folds the line before a card, keeps the answer after it, and shows a run's last line when it ended on work", () => {
  const events = [
    { kind: "owner_message", text: "Check the stats", attachments: [] },
    { kind: "run", run: { ...run, state: "starting" } },
    { kind: "assistant_text", text: "Sending you the login form." },
    { kind: "owner_request", request: { ...ownerRequest, kind: "login", site: "roblox.com", loginName: "Roblox" } },
    { kind: "tool_call", tool: "request_login", summary: "request_login" },
    { kind: "assistant_text", text: "I need your Roblox login." },
    { kind: "run", run: { ...run, state: "exited" } },
    { kind: "run", run: { ...run, state: "starting" } },
    { kind: "assistant_text", text: "Signed in. Pulling the stats." },
    { kind: "tool_call", tool: "browser_open", summary: "browser_open" },
    { kind: "run", run: { ...run, state: "exited" } },
  ] as const;
  const items = chatItems(events.map((event, index) => ({ taskId: taskId as never, seq: index + 1, at, event: event as never })));
  expect(items.map(item => item.kind === "agent" ? `agent: ${item.text}` : item.kind === "steps" ? `steps: ${item.lines.map(line => line.text).join(" | ")}` : item.kind))
    .toEqual([
      "owner",
      "steps: Sending you the login form.",
      "request",
      "steps: request_login · request_login",
      "agent: I need your Roblox login.",
      "steps: browser_open · browser_open",
      "agent: Signed in. Pulling the stats.",
    ]);
});

it("carries image metadata through the chat event projection", () => {
  expect(chatItems([{ taskId: taskId as never, seq: 1, at, event: { kind: "owner_message", text: "", attachments: [attachment] } }])[0]).toMatchObject({ kind: "owner", attachments: [attachment] });
});

describe("chatItems", () => {
  it("folds narration into adjacent steps while keeping the final answer", () => {
    const events = envelopes([
      { kind: "run", run: { ...run, state: "starting" } },
      { kind: "assistant_text", text: "  Opening billing.  " },
      { kind: "tool_call", tool: "browser_open", summary: "Billing" },
      { kind: "tool_result", tool: "browser_open", status: "ok", summary: "" },
      { kind: "assistant_text", text: "Found the invoice." },
      { kind: "tool_call", tool: "browser_download", summary: "" },
      { kind: "assistant_text", text: "The invoice is saved." },
      { kind: "run", run: { ...run, state: "exited" } },
    ]);
    const before = structuredClone(events);
    expect(chatItems(events)).toEqual([
      { kind: "steps", key: "st2", lines: [
        { kind: "note", text: "Opening billing." },
        { kind: "tool", text: "browser_open · Billing" },
        { kind: "tool", text: "browser_open · ok" },
        { kind: "note", text: "Found the invoice." },
        { kind: "tool", text: "browser_download" },
      ] },
      { kind: "agent", key: "t7", seq: 7, text: "The invoice is saved.", live: false },
    ]);
    expect(events).toEqual(before);
  });

  it.each(["exited", "lost", "cancelled"] as const)("promotes only the last narration when a run ends on work: %s", state => {
    const items = chatItems(envelopes([
      { kind: "run", run: { ...run, state: "starting" } },
      { kind: "assistant_text", text: "Opening billing." },
      { kind: "tool_call", tool: "browser_open", summary: "" },
      { kind: "assistant_text", text: "The file is saved." },
      { kind: "tool_result", tool: "browser_download", status: "ok", summary: "Saved" },
      { kind: "run", run: { ...run, state } },
    ]));
    expect(items).toEqual([
      { kind: "steps", key: "st2", lines: [
        { kind: "note", text: "Opening billing." },
        { kind: "tool", text: "browser_open" },
        { kind: "tool", text: "browser_download · ok · Saved" },
      ] },
      { kind: "agent", key: "t4", seq: 4, text: "The file is saved.", live: false },
    ]);
  });

  it("keeps cards at their original positions and updates domain decisions in place", () => {
    const events = envelopes([
      { kind: "assistant_text", text: "I need access." },
      { kind: "owner_request", request: ownerRequest },
      { kind: "domain_request", requestId: domainRequestId as never, domains: ["billing.example.com"], reason: "Get the invoice" },
      { kind: "tool_call", tool: "request_domains", summary: "Billing" },
      { kind: "domain_decided", requestId: domainRequestId as never, decision: "allow_task", attended: false },
      { kind: "assistant_text", text: "Saved." },
    ]);
    const before = structuredClone(events);
    const items = chatItems(events);
    expect(items.map(item => item.kind)).toEqual(["steps", "request", "domain", "steps", "agent"]);
    expect(items[1]).toEqual({ kind: "request", key: "e2", seq: 2, request: ownerRequest });
    expect(items[2]).toEqual({ kind: "domain", key: "e3", seq: 3, at, requestId: domainRequestId, domains: ["billing.example.com"], reason: "Get the invoice", decision: "allow_task" });
    expect(events).toEqual(before);
    expect(chatItems(events.slice(0, 4))[2]).toMatchObject({ kind: "domain", key: "e3", decision: null });
  });

  it("ignores decisions without a card, whitespace text and duplicate errors", () => {
    expect(chatItems(envelopes([
      { kind: "domain_decided", requestId: domainRequestId as never, decision: "skip", attended: false },
      { kind: "assistant_text", text: " \n " },
      { kind: "assistant_text", text: "Cannot continue." },
      { kind: "error", message: " Cannot continue. " },
      { kind: "error", message: "Try again." },
      { kind: "error", message: "Try again." },
      { kind: "state", state: "failed", blockedReason: null },
    ]))).toEqual([
      { kind: "agent", key: "t3", seq: 3, text: "Cannot continue.", live: false },
      { kind: "notice", key: "e5", text: "Try again.", tone: "info" },
    ]);
  });

  it("keeps live drafts and terminal notices", () => {
    expect(chatItems(envelopes([{ kind: "assistant_delta", text: "Writing" }]))).toEqual([
      { kind: "agent", key: "t1", seq: null, text: "Writing", live: true },
    ]);
    expect(chatItems(envelopes([
      { kind: "state", state: "completed", blockedReason: null },
      { kind: "state", state: "cancelled", blockedReason: null },
    ]))).toEqual([
      { kind: "notice", key: "e1", text: "Done", tone: "info" },
      { kind: "notice", key: "e2", text: "Cancelled", tone: "info" },
    ]);
  });
});

describe("chat labels", () => {
  it.each([
    [undefined, "Making progress"],
    ["unknown_tool", "Making progress"],
    ["browser_open · url: https://www.example.com/billing", "Opening example.com"],
    ["browser_navigate · url: https://)", "Opening a page"],
    ["browser_snapshot", "Reading the page"],
    ["browser_screenshot", "Looking at the page"],
    ["browser_click", "Clicking around"],
    ["browser_type", "Typing"],
    ["browser_scroll", "Looking around"],
    ["browser_wait", "Waiting for the page"],
    ["browser_download", "Downloading"],
    ["browser_fill_login", "Signing in"],
    ["files_edit", "Working on files"],
    ["workspace_exec", "Running a command"],
    ["attach_result", "Attaching the results"],
    ["request_domains", "Asking you"],
  ])("describes %s", (line, expected) => {
    expect(describeStep(line)).toBe(expected);
  });

  it("prefers narration for status and skips tool results when describing the current tool", () => {
    expect(workingStatus([])).toBe("Making progress");
    expect(workingStatus([{ kind: "tool", text: "browser_open" }, { kind: "tool", text: "files_read · ok · Read" }])).toBe("Opening a page");
    expect(workingStatus([{ kind: "note", text: "Found the report." }, { kind: "tool", text: "browser_open" }])).toBe("Found the report.");
  });

  it("labels answered requests and each domain decision", () => {
    expect(askedLine(ownerRequest)).toBe(ownerRequest.text);
    expect(askedLine({ ...ownerRequest, kind: "login" })).toBe("Asked for a login to a site");
    expect(askedLine({ ...ownerRequest, kind: "login", site: "example.com" })).toBe("Asked for a login to example.com");
    expect(askedLine({ ...ownerRequest, kind: "connect" })).toBe("Asked to connect Gmail");
    expect(askedLine({ ...ownerRequest, kind: "takeover" })).toBe("Asked you to take over the browser");
    expect(["allow_task", "allow_always", "refuse", "skip", null].map(decision => sitesLine(decision as Parameters<typeof sitesLine>[0], "example.com"))).toEqual([
      "Allowed example.com for this task", "Allowed example.com", "Refused example.com", "Skipped access to example.com", "Access to example.com was not decided",
    ]);
  });

  it("formats today, yesterday and older timestamps using the caller's locale", () => {
    const date = new Date(2026, 9, 17, 8, 16);
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(timeLabel(date.toISOString(), new Date(2026, 9, 17, 22))).toBe(`Today ${time}`);
    expect(timeLabel(date.toISOString(), new Date(2026, 9, 18, 1))).toBe(`Yesterday ${time}`);
    expect(timeLabel(date.toISOString(), new Date(2026, 9, 20))).toBe(`${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`);
  });
});
