import { z } from "zod";
import { RunImage, MAX_MESSAGE_IMAGES } from "./attachments.js";
import { LIMITS } from "./limits.js";
import { AgentId, Effort, ModelId, RelPath, RunId } from "./primitives.js";

// The supervisor is the only process with the Docker socket. It listens on a unix socket that only the control
// plane mounts. Every operation names an agent; images, users, mounts, networks, limits and commands come from
// the supervisor's own fixed template, never from the request.
// POST /v1/agents/:agentId/wipe {} removes the sandboxes and empties the slot's data; 409 while busy or killed.

export const SandboxName = z.enum(["cli", "tools", "browser"]);
export type SandboxName = z.infer<typeof SandboxName>;

export const SandboxStatus = z.object({
  name: SandboxName,
  container: z.string(),
  state: z.enum(["missing", "created", "running", "exited", "paused", "restarting", "dead"]),
  runtime: z.string(),
  startedAt: z.string().nullable(),
  memoryBytes: z.number().int().nullable(),
});
export type SandboxStatus = z.infer<typeof SandboxStatus>;

export const ComputerStatus = z.object({
  agentId: AgentId,
  // Set by killComputer; nothing starts while it is set. Cleared only by unlatch.
  killed: z.boolean(),
  killedAt: z.string().nullable(),
  sandboxes: z.array(SandboxStatus),
});
export type ComputerStatus = z.infer<typeof ComputerStatus>;

// Fixed programs in the tools sandbox image.
export const TOOLS_PATHS = {
  filesHelper: "/opt/quokkabot/bin/qb-files",
  // Kills every process outside session 1 (the image's init and its `sleep infinity`), so the sandbox stays up.
  resetTools: "/opt/quokkabot/bin/reset-tools",
} as const;

// POST /v1/agents/:agentId/runs
export const StartRunRequest = z
  .object({
    runId: RunId,
    sessionId: z.uuid(),
    resume: z.boolean(),
    model: ModelId,
    effort: Effort,
    // Per-run token for Quokka Bot's MCP endpoint, revoked when the run ends.
    mcpToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    // Delivered to the CLI on stdin, never on the command line.
    prompt: z.string().max(100_000),
    images: z.array(RunImage).max(MAX_MESSAGE_IMAGES).default([]),
  })
  .strict();
export type StartRunRequest = z.infer<typeof StartRunRequest>;

export const RunStatus = z.object({
  runId: RunId,
  agentId: AgentId,
  state: z.enum(["starting", "running", "exited", "lost", "cancelled"]),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  // Number of stdout lines recorded so far; output is replayable from any offset.
  lines: z.number().int().min(0),
  lastOutputAt: z.string().nullable(),
});
export type RunStatus = z.infer<typeof RunStatus>;

// GET /v1/runs/:runId/output?from=<line>&wait=<seconds> returns NDJSON of these.
export const RunOutputLine = z.object({
  n: z.number().int().min(0),
  stream: z.enum(["stdout", "stderr"]),
  line: z.string(),
});
export type RunOutputLine = z.infer<typeof RunOutputLine>;

// POST /v1/agents/:agentId/exec – a shell command in the tools sandbox (bash -lc as the workspace user, no
// network). The command is model-authored; the sandbox is the boundary.
export const ExecRequest = z
  .object({
    execId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    command: z.string().min(1).max(LIMITS.execCommandChars),
    cwd: RelPath,
    timeoutS: z.number().int().min(1).max(LIMITS.execTimeoutSecondsMax),
  })
  .strict();
export type ExecRequest = z.infer<typeof ExecRequest>;

export const ExecResult = z.object({
  execId: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});
export type ExecResult = z.infer<typeof ExecResult>;

// POST /v1/agents/:agentId/files – runs Quokka Bot's file helper inside the tools sandbox with this request as JSON on
// stdin. The helper resolves every path beneath its root and refuses symlinks, special files and traversal.
export const FilesRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), scope: z.enum(["workspace", "downloads"]), dir: RelPath, cursor: z.string().max(200).optional() }).strict(),
  z
    .object({
      op: z.literal("read"),
      scope: z.enum(["workspace", "downloads"]),
      path: RelPath,
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(2000).optional(),
    })
    .strict(),
  z.object({ op: z.literal("write"), path: RelPath, content: z.string().max(LIMITS.fileWriteChars) }).strict(),
  z
    .object({
      op: z.literal("edit"),
      path: RelPath,
      oldString: z.string().min(1),
      newString: z.string(),
      replaceAll: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal("copy_from_downloads"), source: RelPath, dest: RelPath }).strict(),
  z.object({ op: z.literal("stat"), scope: z.enum(["workspace", "downloads"]), path: RelPath }).strict(),
]);
export type FilesRequest = z.infer<typeof FilesRequest>;

export const FileEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir"]),
  bytes: z.number().int().min(0),
  modifiedAt: z.string(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const FilesResult = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list"), entries: z.array(FileEntry), nextCursor: z.string().nullable() }),
  z.object({
    op: z.literal("read"),
    kind: z.enum(["text", "pdf_text", "image"]),
    // Text with line numbers for text and PDF; base64 for images.
    content: z.string(),
    mimeType: z.string(),
    totalLines: z.number().int().nullable(),
    nextOffset: z.number().int().nullable(),
  }),
  z.object({ op: z.literal("write"), bytes: z.number().int() }),
  z.object({ op: z.literal("edit"), replacements: z.number().int() }),
  z.object({ op: z.literal("copy_from_downloads"), bytes: z.number().int(), sha256: z.string() }),
  z.object({ op: z.literal("stat"), entry: FileEntry, sha256: z.string().nullable() }),
  z.object({ op: z.literal("error"), code: z.enum(["not_found", "not_a_file", "refused", "too_large", "no_match", "multiple_matches", "invalid"]), message: z.string() }),
]);
export type FilesResult = z.infer<typeof FilesResult>;

// Terminal WebSocket frames between control and supervisor (and, relayed, the owner's browser).
export const TerminalClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("in"), d: z.string().max(65_536) }),
  z.object({ t: z.literal("resize"), cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) }),
]);
export type TerminalClientFrame = z.infer<typeof TerminalClientFrame>;
export const TerminalServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("out"), d: z.string() }),
  z.object({ t: z.literal("exit"), code: z.number().int().nullable() }),
]);
export type TerminalServerFrame = z.infer<typeof TerminalServerFrame>;

// POST /v1/agents/:agentId/files/export – streams the raw bytes of one file from the tools sandbox
// (application/octet-stream). The helper validates the path the same way as FilesRequest.
export const FilesExportRequest = z
  .object({ scope: z.enum(["workspace", "downloads"]), path: RelPath })
  .strict();
export type FilesExportRequest = z.infer<typeof FilesExportRequest>;

// POST /v1/agents/:agentId/workspace-file?path=<RelPath> writes one binary image to the workspace.
// Body: application/octet-stream, at most MAX_IMAGE_BYTES; no host paths or symlink traversal.
