import type { RunImage } from "./attachments.js";
import { MCP_SERVER_NAME } from "./mcp-tools.js";
import type { Effort, ModelId } from "./primitives.js";

// The pinned Claude Code release and the exact way Quokka Bot launches it. Both the supervisor (which runs it) and
// the control plane (which reads its output) use these. Changing the version means rerunning the CLI fixture
// suite on the host.
export const CLAUDE_CODE_VERSION = "2.1.302";

// Paths inside the CLI sandbox image.
export const CLI_PATHS = {
  home: "/home/claude",
  // Trusted working directory: owned by root, read-only, holds nothing the model wrote.
  workdir: "/opt/quokkabot/cli-workdir",
  mcpConfig: "/run/quokkabot/mcp.json",
  runWrapper: "/opt/quokkabot/bin/run-cli",
  cancelWrapper: "/opt/quokkabot/bin/cancel-cli",
  cleanupSession: "/opt/quokkabot/bin/cleanup-session",
  // The owner's sign-in terminal: records its session id, then execs `bash -l`. Closing the WebSocket does not hang
  // up a Docker exec, so the supervisor runs closeOwnerShell to kill that whole session when the owner leaves.
  ownerShell: "/opt/quokkabot/bin/owner-shell",
  closeOwnerShell: "/opt/quokkabot/bin/close-owner-shell",
  signInWrapper: "/opt/quokkabot/bin/sign-in-cli",
  cancelSignIn: "/opt/quokkabot/bin/cancel-sign-in",
  claude: "/usr/local/bin/claude",
} as const;

export interface ClaudeTaskLaunch {
  runId: string;
  model: ModelId;
  effort: Effort;
  sessionId: string;
  resume: boolean;
}

// argv for one task run. The prompt goes on stdin. The run wrapper records the process group so a cancel can stop
// the CLI and everything it started, then execs the CLI.
export function claudeTaskArgv(launch: ClaudeTaskLaunch): string[] {
  return [
    CLI_PATHS.runWrapper,
    launch.runId,
    CLI_PATHS.claude,
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--restricted",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    CLI_PATHS.mcpConfig,
    "--allowedTools",
    `mcp__${MCP_SERVER_NAME}`,
    "--permission-prompts",
    "none",
    "--no-chrome",
    "--disable-slash-commands",
    "--model",
    launch.model,
    "--effort",
    launch.effort,
    ...(launch.resume ? ["--resume", launch.sessionId] : ["--session-id", launch.sessionId]),
  ];
}

// The CLI's complete environment for a task run. No API key, no auth token, no base URL override: the CLI signs in
// with the owner's own plan from its private home.
export function claudeTaskEnv(proxyUrl: string): Record<string, string> {
  return {
    HOME: CLI_PATHS.home,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    NO_PROXY: "quokkabot-control",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  };
}

// MCP configuration written into the CLI sandbox for one run. The token is per run and revoked when it ends.
export function claudeMcpConfig(mcpUrl: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } },
    },
  });
}

// A single owner message works for both new sessions and resumed sessions. Keep image bytes off argv.
export function claudeUserMessage(prompt: string, images: readonly RunImage[] = []): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [
    ...images.map(image => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
    { type: "text", text: prompt },
  ] } }) + "\n";
}
