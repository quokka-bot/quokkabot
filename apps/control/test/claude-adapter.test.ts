import { describe, expect, it } from "vitest";
import { ClaudeStreamParser, classifyExit, summarizeToolInput } from "../src/claude-adapter.js";

const line = (value: unknown): string => JSON.stringify(value);

describe("ClaudeStreamParser", () => {
  it("flags a missing Quokka Bot MCP server on init", () => {
    const parser = new ClaudeStreamParser();
    const out = parser.parseLine(line({ type: "system", subtype: "init", session_id: "s1", mcp_servers: [{ name: "quokkabot", status: "failed" }] }));
    expect(out.mcpFailed).toBe(true);
    expect(out.events[0]).toMatchObject({ kind: "error" });
    const ok = parser.parseLine(line({ type: "system", subtype: "init", mcp_servers: [{ name: "quokkabot", status: "connected" }] }));
    expect(ok.mcpFailed).toBe(false);
    expect(ok.events).toEqual([]);
  });

  it("streams top-level text deltas only", () => {
    const parser = new ClaudeStreamParser();
    const delta = (parent: string | null) =>
      line({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
    expect(parser.parseLine(delta(null)).events).toEqual([{ kind: "assistant_delta", text: "Hel" }]);
    expect(parser.parseLine(delta("toolu_1")).events).toEqual([]);
    const json = line({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"text\":\"sec" } } });
    expect(parser.parseLine(json).events).toEqual([]);
  });

  it("turns assistant messages into text and tool calls, and labels results", () => {
    const parser = new ClaudeStreamParser();
    const assistant = parser.parseLine(
      line({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "text", text: "Opening the billing page." },
            { type: "tool_use", id: "toolu_9", name: "mcp__quokkabot__browser_type", input: { tab: "t1", snapshot: 2, ref: "e4", text: "secret words" } },
          ],
        },
      }),
    );
    expect(assistant.events[0]).toEqual({ kind: "assistant_text", text: "Opening the billing page." });
    expect(assistant.events[1]).toMatchObject({ kind: "tool_call", tool: "browser_type" });
    expect(JSON.stringify(assistant.events[1])).not.toContain("secret words");
    const result = parser.parseLine(
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [{ type: "text", text: "status: blocked\npassword fields are typed by the owner" }] }] } }),
    );
    expect(result.events[0]).toMatchObject({ kind: "tool_result", tool: "browser_type", status: "blocked" });
  });

  it("reads the final result", () => {
    const parser = new ClaudeStreamParser();
    const out = parser.parseLine(
      line({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "s1", total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 5 } }),
    );
    expect(out.result).toMatchObject({ isError: false, text: "Done.", costUsd: 0.12, inputTokens: 10, outputTokens: 5 });
  });

  it("ignores garbage and unknown types", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.parseLine("not json").events).toEqual([]);
    expect(parser.parseLine(line({ type: "future_type" })).events).toEqual([]);
  });
});

describe("classifyExit", () => {
  const ok = { isError: false, subtype: "success", text: "Done.", sessionId: "s", costUsd: null, inputTokens: 0, outputTokens: 0 };
  it("completes on a clean result", () => {
    expect(classifyExit(0, ok, "")).toEqual({ kind: "completed", text: "Done." });
  });
  it("detects a signed-out CLI", () => {
    const res = classifyExit(1, { ...ok, isError: true, text: "Invalid API key · Please run /login" }, "");
    expect(res).toMatchObject({ kind: "failed", signedOut: true });
  });
  it("detects a plan limit", () => {
    const res = classifyExit(1, { ...ok, isError: true, text: "Claude AI usage limit reached|1792300000" }, "");
    expect(res).toMatchObject({ kind: "failed", planLimit: true, signedOut: false });
  });
  it("is lost without exit code or result", () => {
    expect(classifyExit(null, null, "")).toEqual({ kind: "lost" });
  });
});

describe("summarizeToolInput", () => {
  it("shows commands and urls, hides free text", () => {
    expect(summarizeToolInput("workspace_exec", { command: "pdftotext a.pdf -" })).toContain("pdftotext a.pdf -");
    expect(summarizeToolInput("files_write", { path: "a.txt", content: "abc" })).toBe("files_write (path: a.txt; content: 3 chars)");
  });
});
