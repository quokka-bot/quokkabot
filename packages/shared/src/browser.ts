import { z } from "zod";
import { LIMITS } from "./limits.js";
import { DomainPattern, DownloadId, ElementRef, HttpUrl, RunId, SnapshotGeneration, TabRef } from "./primitives.js";

// Keys the agent may press. Page interaction only: no modifiers, so no clipboard, devtools, address bar,
// new-window or print shortcuts.
export const BrowserKey = z.enum([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);
export type BrowserKey = z.infer<typeof BrowserKey>;

// Typed wait conditions. Nothing executable: no JavaScript, no selectors.
export const WaitCondition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("text_gone"), text: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("url_contains"), value: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("load") }).strict(),
  z.object({ kind: z.literal("network_idle") }).strict(),
]);
export type WaitCondition = z.infer<typeof WaitCondition>;

const tab = TabRef;
const snapshot = SnapshotGeneration;
const ref = ElementRef;

// One operation of the browser service. The control plane validates the MCP call, maps it to one of these and
// sends it with a command id, the run id and the current control generation.
export const BrowserOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("tabs") }).strict(),
  z.object({ op: z.literal("open"), url: HttpUrl }).strict(),
  z.object({ op: z.literal("navigate"), tab, url: HttpUrl }).strict(),
  z.object({ op: z.literal("activate"), tab }).strict(),
  z.object({ op: z.literal("close"), tab }).strict(),
  z
    .object({
      op: z.literal("snapshot"),
      tab,
      interactiveOnly: z.boolean().default(false),
      page: z.number().int().min(1).max(1000).default(1),
    })
    .strict(),
  z.object({ op: z.literal("click"), tab, snapshot, ref }).strict(),
  z
    .object({
      op: z.literal("type"),
      tab,
      snapshot,
      ref,
      text: z.string().max(LIMITS.typeTextChars),
      mode: z.enum(["replace", "append"]).default("replace"),
      submit: z.boolean().default(false),
    })
    .strict(),
  z.object({ op: z.literal("select"), tab, snapshot, ref, option: z.string().min(1).max(500) }).strict(),
  z.object({ op: z.literal("check"), tab, snapshot, ref, checked: z.boolean() }).strict(),
  z.object({ op: z.literal("press"), tab, key: BrowserKey }).strict(),
  z
    .object({
      op: z.literal("scroll"),
      tab,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.enum(["line", "half", "page"]).default("page"),
    })
    .strict(),
  z
    .object({
      op: z.literal("wait"),
      tab,
      until: WaitCondition,
      timeoutS: z.number().int().min(1).max(LIMITS.waitTimeoutSecondsMax).default(10),
    })
    .strict(),
  z.object({ op: z.literal("back"), tab }).strict(),
  z.object({ op: z.literal("forward"), tab }).strict(),
  z.object({ op: z.literal("reload"), tab }).strict(),
  z.object({ op: z.literal("screenshot"), tab }).strict(),
  z.object({ op: z.literal("download"), tab, snapshot, ref }).strict(),
]);
export type BrowserOp = z.infer<typeof BrowserOp>;
export type BrowserOpName = BrowserOp["op"];

// Operations that change page or account state. A lost reply to one of these is `outcome_unknown`, never
// retried automatically.
export const MUTATING_BROWSER_OPS: ReadonlySet<BrowserOpName> = new Set([
  "open",
  "navigate",
  "close",
  "click",
  "type",
  "select",
  "check",
  "press",
  "back",
  "forward",
  "reload",
  "download",
]);

export const CommandStatus = z.enum(["ok", "blocked", "invalid", "failed", "outcome_unknown"]);
export type CommandStatus = z.infer<typeof CommandStatus>;

export const TabInfo = z.object({ tab: TabRef, url: z.string(), title: z.string(), active: z.boolean() });
export type TabInfo = z.infer<typeof TabInfo>;

export const DownloadState = z.enum(["in_progress", "completed", "failed", "cancelled"]);
export type DownloadState = z.infer<typeof DownloadState>;

export const DownloadInfo = z.object({
  downloadId: DownloadId,
  // Chromium's download GUID; the staging file is named after it.
  guid: z.string().regex(/^[0-9a-fA-F-]{36}$/),
  state: DownloadState,
  suggestedFilename: z.string().max(255),
  url: z.string().max(4096),
  receivedBytes: z.number().int().min(0),
  totalBytes: z.number().int().min(0).nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  // Command that started it, if the agent started it. A download the owner starts during a takeover has none.
  commandId: z.string().nullable(),
  runId: RunId.nullable(),
});
export type DownloadInfo = z.infer<typeof DownloadInfo>;

export const BrowserCommandResult = z.object({
  commandId: z.string(),
  status: CommandStatus,
  message: z.string().max(2000).optional(),
  // Present on navigation-like results.
  tab: TabRef.optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  tabs: z.array(TabInfo).optional(),
  // Snapshot results.
  snapshot: SnapshotGeneration.optional(),
  text: z.string().optional(),
  page: z.number().int().optional(),
  pages: z.number().int().optional(),
  // Hosts the egress proxy refused while this command ran.
  blockedHosts: z.array(z.string()).optional(),
  // Set when the action started a download.
  download: z.object({ downloadId: DownloadId, suggestedFilename: z.string() }).optional(),
  // Screenshot as base64 PNG.
  pngBase64: z.string().optional(),
});
export type BrowserCommandResult = z.infer<typeof BrowserCommandResult>;

// Who may drive the browser. Every change bumps the generation; commands carry the generation they were issued
// under and are refused when it is stale.
export const ControlLease = z.object({
  holder: z.enum(["agent", "owner", "paused"]),
  generation: z.number().int().min(1),
  expiresAt: z.string().nullable(),
});
export type ControlLease = z.infer<typeof ControlLease>;

export const BrowserCommandRequest = z
  .object({
    commandId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    runId: RunId,
    generation: z.number().int().min(1),
    op: BrowserOp,
  })
  .strict();
export type BrowserCommandRequest = z.infer<typeof BrowserCommandRequest>;

// POST /v1/secret-fill: types a value the control plane took from the login vault into one field. Separate from
// /v1/commands so it can never be reached through a model-chosen operation. The service checks, immediately before
// typing, that the field's own frame is on one of `allowedPatterns` (a login never goes to another site), that the field
// is the kind requested (a password field for "password", a text or email field for "username", a one-time-code or
// short numeric field for "code"), types through DevTools input events (the value never passes through agent-browser,
// a command line or a log), and returns only whether it typed.
export const SecretFillRequest = z
  .object({
    commandId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    runId: RunId,
    generation: z.number().int().min(1),
    tab: TabRef,
    snapshot: SnapshotGeneration,
    ref: ElementRef,
    kind: z.enum(["username", "password", "code"]),
    value: z.string().min(1).max(500),
    allowedPatterns: z.array(DomainPattern).min(1).max(20),
    submit: z.boolean(),
  })
  .strict();
export type SecretFillRequest = z.infer<typeof SecretFillRequest>;

// The owner's native fields never pass through a model tool. Only the current owner lease may inspect or fill
// the inspected element. The single-use handle binds the lease, document and origin checked at insertion.
export const OwnerFieldKind = z.enum(["password", "code"]);
export type OwnerFieldKind = z.infer<typeof OwnerFieldKind>;
export const OwnerFocusId = z.string().regex(/^[a-f0-9]{64}$/);
export const OwnerFocusResult = z.object({ field: z.object({ origin: z.string(), kind: OwnerFieldKind, focusId: OwnerFocusId }).strict().nullable() }).strict();
export type OwnerFocusResult = z.infer<typeof OwnerFocusResult>;
export const OwnerFillRequest = z.object({
  commandId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  leaseGeneration: z.number().int().min(1),
  kind: OwnerFieldKind,
  value: z.string().min(1).max(500),
  focusId: OwnerFocusId,
  submit: z.boolean(),
}).strict();
export type OwnerFillRequest = z.infer<typeof OwnerFillRequest>;

// The computer's screen. The agent always works on the desktop size. While the owner has control, a phone may fit
// the screen to itself (PUT /v1/screen with the owner's lease generation); every lease that leaves the owner puts
// the desktop size back. Widths are whole 8-pixel cells and heights even, so the X server realizes them exactly. The
// narrowest screen is 504: Chrome's windows are at least 500 pixels wide, and a narrower screen leaves them cut off.
export const DESKTOP_SCREEN = Object.freeze({ width: 1280, height: 800 });
export const SCREEN_MIN_WIDTH = 504;
export const ScreenSize = z.object({
  width: z.number().int().min(SCREEN_MIN_WIDTH).max(1920).multipleOf(8),
  height: z.number().int().min(240).max(1920).multipleOf(2),
}).strict();
export type ScreenSize = z.infer<typeof ScreenSize>;
export const ScreenRequest = ScreenSize.extend({ leaseGeneration: z.number().int().min(1) }).strict();
export type ScreenRequest = z.infer<typeof ScreenRequest>;


// POST /v1/site-data/clear: when an attended session ends, every cookie and every origin's storage that matches one of
// the patterns is removed (any subdomain, http and https). The response lists what was cleared; an error means some of
// it was not, and the caller keeps the session marked as closing and retries.
export const SiteDataClearRequest = z.object({ patterns: z.array(DomainPattern).min(1).max(200) }).strict();
export type SiteDataClearRequest = z.infer<typeof SiteDataClearRequest>;
export const SiteDataClearResult = z.object({ cookiesDeleted: z.number().int().min(0), originsCleared: z.array(z.string()) });
export type SiteDataClearResult = z.infer<typeof SiteDataClearResult>;
