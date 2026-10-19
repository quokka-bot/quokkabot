import { CLAUDE_CODE_VERSION, MCP_SERVER_NAME, type TaskEvent } from "@quokkabot/shared";

// Reads Claude Code's `--output-format stream-json --verbose --include-partial-messages` output. Each stdout line is
// one JSON object. Unknown types are ignored so a CLI upgrade degrades to less detail, not to a failure; the fixture
// suite on the host catches format changes before an upgrade ships.

export const ADAPTER_CLI_VERSION = CLAUDE_CODE_VERSION;

export interface ParsedResult {
  isError: boolean;
  subtype: string;
  text: string;
  sessionId: string | null;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
}

export interface LineOutcome {
  events: TaskEvent[];
  result: ParsedResult | null;
  sessionId: string | null;
  // Set when the init line shows the Quokka Bot MCP server failed to connect.
  mcpFailed: boolean;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export function shortToolName(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

// One line describing a tool call for the owner. Free text the model typed or wrote is reduced to its length;
// commands and URLs are shown (cut to 200 characters) because they are what the owner needs to follow the work.
export function summarizeToolInput(tool: string, input: unknown): string {
  if (!isObject(input)) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (["text", "content", "new_string", "old_string", "body", "subject", "query", "to", "cc"].includes(key)) {
      const length = typeof value === "string" ? value.length : Array.isArray(value) ? JSON.stringify(value).length : 0;
      parts.push(`${key}: ${length} chars`);
    } else if (typeof value === "string") {
      parts.push(`${key}: ${value.length > 200 ? `${value.slice(0, 200)}…` : value}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}: ${value.length > 5 ? `${value.slice(0, 5).join(", ")} +${value.length - 5}` : value.join(", ")}`);
    } else if (isObject(value)) {
      parts.push(`${key}: ${JSON.stringify(value).slice(0, 120)}`);
    }
  }
  return `${tool}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isObject(block) && block.type === "text" ? (str(block.text) ?? "") : isObject(block) && block.type === "image" ? "[image]" : ""))
      .join("\n");
  }
  return "";
}

export class ClaudeStreamParser {
  // tool_use id -> tool name, to label results.
  private readonly toolNames = new Map<string, string>();

  parseLine(line: string): LineOutcome {
    const outcome: LineOutcome = { events: [], result: null, sessionId: null, mcpFailed: false };
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return outcome;
    }
    if (!isObject(value)) return outcome;
    const type = str(value.type);
    outcome.sessionId = str(value.session_id);

    if (type === "system" && value.subtype === "init") {
      const servers = Array.isArray(value.mcp_servers) ? value.mcp_servers : [];
      const ours = servers.find((s) => isObject(s) && s.name === MCP_SERVER_NAME);
      if (!isObject(ours) || ours.status !== "connected") {
        outcome.mcpFailed = true;
        outcome.events.push({ kind: "error", message: `Quokka Bot tools are not connected (${isObject(ours) ? String(ours.status) : "missing"})` });
      }
      return outcome;
    }

    if (type === "stream_event" && isObject(value.event)) {
      // Only top-level assistant text is streamed live; sub-agent text and tool input fragments are not shown.
      if (value.parent_tool_use_id !== null && value.parent_tool_use_id !== undefined) return outcome;
      const event = value.event;
      if (event.type === "content_block_delta" && isObject(event.delta) && event.delta.type === "text_delta") {
        const text = str(event.delta.text);
        if (text) outcome.events.push({ kind: "assistant_delta", text });
      }
      return outcome;
    }

    if (type === "assistant" && isObject(value.message)) {
      const content = Array.isArray(value.message.content) ? value.message.content : [];
      const texts: string[] = [];
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block.type === "text") {
          const text = str(block.text);
          if (text) texts.push(text);
        } else if (block.type === "tool_use") {
          const name = shortToolName(str(block.name) ?? "unknown");
          const id = str(block.id);
          if (id) this.toolNames.set(id, name);
          outcome.events.push({ kind: "tool_call", tool: name, summary: summarizeToolInput(name, block.input) });
        }
      }
      if (texts.length > 0 && (value.parent_tool_use_id === null || value.parent_tool_use_id === undefined)) {
        outcome.events.unshift({ kind: "assistant_text", text: texts.join("\n\n") });
      }
      return outcome;
    }

    if (type === "user" && isObject(value.message)) {
      const content = Array.isArray(value.message.content) ? value.message.content : [];
      for (const block of content) {
        if (!isObject(block) || block.type !== "tool_result") continue;
        const id = str(block.tool_use_id);
        const tool = (id && this.toolNames.get(id)) ?? "tool";
        const text = toolResultText(block.content);
        const status = block.is_error === true ? "error" : (/^status: (\w+)/m.exec(text)?.[1] ?? "ok");
        outcome.events.push({ kind: "tool_result", tool, status, summary: text.slice(0, 300) });
      }
      return outcome;
    }

    if (type === "result") {
      const usage = isObject(value.usage) ? value.usage : {};
      const result: ParsedResult = {
        isError: value.is_error === true || (str(value.subtype) ?? "") !== "success",
        subtype: str(value.subtype) ?? "unknown",
        text: str(value.result) ?? "",
        sessionId: str(value.session_id),
        costUsd: num(value.total_cost_usd),
        inputTokens: num(usage.input_tokens) ?? 0,
        outputTokens: num(usage.output_tokens) ?? 0,
      };
      outcome.result = result;
      outcome.events.push({
        kind: "usage",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      });
      if (result.isError) outcome.events.push({ kind: "error", message: result.text.slice(0, 500) || result.subtype });
      return outcome;
    }

    return outcome;
  }
}

export type ExitClass =
  | { kind: "completed"; text: string }
  | { kind: "failed"; reason: string; signedOut: boolean; planLimit: boolean }
  | { kind: "lost" };

const SIGNED_OUT = /not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error|401/i;
const PLAN_LIMIT = /usage limit|limit reached|rate limit|resets? (at|in)|weekly limit|5-hour limit/i;

export function classifyExit(exitCode: number | null, result: ParsedResult | null, stderrTail: string): ExitClass {
  if (result && !result.isError && exitCode === 0) return { kind: "completed", text: result.text };
  const text = `${result?.text ?? ""}\n${stderrTail}`;
  if (result === null && exitCode === null) return { kind: "lost" };
  return {
    kind: "failed",
    reason: (result?.text || stderrTail || `CLI exited with code ${exitCode ?? "unknown"}`).slice(0, 500),
    signedOut: SIGNED_OUT.test(text),
    planLimit: PLAN_LIMIT.test(text),
  };
}
