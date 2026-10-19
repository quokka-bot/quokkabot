import type { Effort, ModelId } from "./primitives.js";
import type { TaskEvent } from "./tasks.js";

// One provider CLI (Claude Code now; Codex, Grok Build and Copilot later). An adapter only describes how to launch
// the provider's unmodified CLI and how to read its output. It never sees or returns a subscription credential.

export interface FixedLaunchSpec {
  // argv[0] is an absolute path inside the CLI sandbox.
  argv: readonly string[];
  // The complete environment; nothing is inherited.
  env: Readonly<Record<string, string>>;
  // Sent on stdin, then stdin is closed.
  stdin: string;
  cwd: string;
}

export interface TaskLaunchInput {
  prompt: string;
  model: ModelId;
  effort: Effort;
  sessionId: string;
  resume: boolean;
  mcpUrl: string;
  mcpToken: string;
}

export type ProcessExit = { exitCode: number | null; signal: string | null; lastResult: unknown };

export type TaskOutcome =
  | { kind: "completed"; summary: string; sessionId: string | null }
  | { kind: "failed"; reason: string; planLimit: boolean }
  | { kind: "lost" };

export interface ProviderAdapter {
  readonly id: "claude-code";
  readonly cliVersion: string;
  ownerTerminal(): FixedLaunchSpec;
  taskLaunch(input: TaskLaunchInput): FixedLaunchSpec;
  // One stdout line of the CLI's stream to zero or more owner-facing events. Unknown lines are ignored.
  normalizeLine(line: string): TaskEvent[];
  classifyExit(exit: ProcessExit): TaskOutcome;
}
