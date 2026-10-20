import { z } from "zod";
import { AttachmentIds } from "./attachments.js";
import { AiConsentView } from "./ai-consent.js";
import { AuditEvent } from "./audit.js";
import { ControlLease, OwnerFillRequest, OwnerFocusResult } from "./browser.js";
import { EgressDecision } from "./egress.js";
import {
  AgentId,
  DomainPattern,
  DomainRequestId,
  Effort,
  FileId,
  ModelId,
  OwnerRequestId,
  RelPath,
  Sha256Hex,
  TaskId,
} from "./primitives.js";
import { SandboxStatus } from "./supervisor.js";
import { DomainDecision, OwnerRequest, ReactionEmoji, Run, Task, TaskEventEnvelope } from "./tasks.js";

// The owner's HTTP API, served by the control plane under /api on the app origin. Every state-changing request
// must carry the exact app Origin; the session is an httpOnly cookie. Errors are { error: { code, message } }.

export const ApiError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ApiError = z.infer<typeof ApiError>;

// --- Owner sign-in (passkeys) -------------------------------------------------------------------------------
// POST /api/setup/options   { ticket }            -> WebAuthn registration options (JSON from SimpleWebAuthn)
// POST /api/setup/verify    { ticket, response }  -> Me
// POST /api/auth/options    {}                    -> WebAuthn authentication options
// POST /api/auth/verify     { response }          -> Me
// POST /api/auth/fresh/options, /api/auth/fresh/verify -> { freshUntil } (re-check for terminal and kill release)
// POST /api/auth/logout
// GET  /api/me                                     -> Me (401 when signed out)
export const SetupOptionsRequest = z.object({ ticket: z.string().min(32).max(200) }).strict();
export const SetupVerifyRequest = z.object({ ticket: z.string().min(32).max(200), response: z.unknown() }).strict();
export const AuthVerifyRequest = z.object({ response: z.unknown() }).strict();
export const Me = z.object({ ownerName: z.string(), passkeys: z.number().int(), freshUntil: z.string().nullable() });
export type Me = z.infer<typeof Me>;

const CredentialDescriptor = z.object({
  id: z.string().min(1), type: z.literal("public-key"),
  transports: z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])).optional(),
});
const UserVerification = z.enum(["required", "preferred", "discouraged"]);
const CredentialHints = z.array(z.enum(["hybrid", "security-key", "client-device"]));
const AuthenticationExtensions = z.object({
  appid: z.string().optional(), credProps: z.boolean().optional(), hmacCreateSecret: z.boolean().optional(),
  minPinLength: z.boolean().optional(),
}).passthrough();
export const WebAuthnAuthenticationOptions = z.object({
  challenge: z.string().min(1), timeout: z.number().positive().optional(), rpId: z.string().min(1).optional(),
  allowCredentials: z.array(CredentialDescriptor).optional(), userVerification: UserVerification.optional(),
  hints: CredentialHints.optional(), extensions: AuthenticationExtensions.optional(),
}).passthrough();
export const WebAuthnRegistrationOptions = z.object({
  challenge: z.string().min(1), rp: z.object({ id: z.string().optional(), name: z.string() }),
  user: z.object({ id: z.string().min(1), name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.object({ type: z.literal("public-key"), alg: z.number().int() })).min(1),
  timeout: z.number().positive().optional(), excludeCredentials: z.array(CredentialDescriptor).optional(),
  authenticatorSelection: z.object({
    authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
    requireResidentKey: z.boolean().optional(), residentKey: z.enum(["required", "preferred", "discouraged"]).optional(),
    userVerification: UserVerification.optional(),
  }).optional(), attestation: z.enum(["none", "direct", "indirect", "enterprise"]).optional(),
  hints: CredentialHints.optional(), extensions: AuthenticationExtensions.optional(),
  attestationFormats: z.array(z.enum(["fido-u2f", "packed", "android-safetynet", "android-key", "tpm", "apple", "none"])).optional(),
}).passthrough();
export type WebAuthnAuthenticationOptions = z.infer<typeof WebAuthnAuthenticationOptions>;
export type WebAuthnRegistrationOptions = z.infer<typeof WebAuthnRegistrationOptions>;

export const FreshAuth = z.object({ freshUntil: z.string().datetime({ offset: true }) });
export const EmptyResponse = z.union([z.null(), z.object({}).strict()]);
export type FreshAuth = z.infer<typeof FreshAuth>;
export type EmptyResponse = z.infer<typeof EmptyResponse>;

// --- Agents and their computer -------------------------------------------------------------------------------
export const ComputerView = z.object({
  state: z.enum(["stopped", "starting", "running", "stopping", "killed", "degraded"]),
  sandboxes: z.array(SandboxStatus),
  lease: ControlLease,
  attendedOpen: z.boolean(),
  killedAt: z.string().nullable(),
});
export type ComputerView = z.infer<typeof ComputerView>;

export const AgentSummary = z.object({
  id: AgentId,
  generation: z.number().int().positive().default(1),
  index: z.number().int().min(1).max(99).default(1),
  removing: z.boolean().default(false),
  name: z.string(),
  model: ModelId,
  effort: Effort,
  cliSignedIn: z.enum(["yes", "no", "unknown"]),
  cliAccount: z.string().nullable().default(null),
  cliPlan: z.string().nullable().default(null),
  computer: ComputerView,
  activeTaskId: TaskId.nullable(),
  waitingOnOwner: z.number().int(),
  // Null from a server older than consent records.
  aiConsent: AiConsentView.nullable().default(null),
});
export type AgentSummary = z.infer<typeof AgentSummary>;

export const AgentName = z.string().trim().min(1).max(40);
export const CreateAgentRequest = z.object({ name: AgentName }).strict();
export const AgentsResponse = z.object({
  agents: z.array(AgentSummary),
  capacity: z.object({ used: z.number().int().nonnegative(), total: z.number().int().positive() }),
});
export type AgentsResponse = z.infer<typeof AgentsResponse>;

// GET  /api/agents                                  -> AgentsResponse
// POST /api/agents { name }                        -> AgentSummary
// DELETE /api/agents/:agentId                      -> {}
// GET  /api/agents/:agentId                         -> AgentSummary
// PUT  /api/agents/:agentId/settings                -> AgentSummary
// POST /api/agents/:agentId/computer/start          -> ComputerView
// POST /api/agents/:agentId/computer/stop           -> ComputerView
// POST /api/agents/:agentId/kill                    -> ComputerView   (no confirmation; instant)
// POST /api/agents/:agentId/kill/release            -> ComputerView   (needs fresh auth)
// POST /api/agents/:agentId/takeover  { action }     -> ControlLease
// GET  /api/agents/:agentId/takeover/focus           -> TakeoverFocusResponse
// POST /api/agents/:agentId/takeover/fill            -> TakeoverFillResponse
// POST /api/agents/:agentId/attended  { open }       -> ComputerView
// POST /api/agents/:agentId/view-ticket              -> { url }  (one-time URL on the viewer origin)
// GET  /api/agents/:agentId/terminal (WebSocket)     needs fresh auth; frames are TerminalClientFrame/ServerFrame
export const AgentSettingsRequest = z.object({ name: AgentName.optional(), model: ModelId, effort: Effort }).strict();
export const TakeoverRequest = z.object({ action: z.enum(["take", "return"]) }).strict();
// Native fields during the owner's takeover. Fill echoes the inspected focusId, never a caller-chosen origin.
// The browser binds that short-lived handle to the inspected lease. Neither response returns a typed value.
export const TakeoverFocusResponse = OwnerFocusResult;
export type TakeoverFocusResponse = z.infer<typeof TakeoverFocusResponse>;
export const TakeoverFillRequest = OwnerFillRequest.omit({ commandId: true, leaseGeneration: true });
export type TakeoverFillRequest = z.infer<typeof TakeoverFillRequest>;
export const TakeoverFillResponse = z.object({ ok: z.literal(true) }).strict();
export type TakeoverFillResponse = z.infer<typeof TakeoverFillResponse>;
export const AttendedRequest = z.object({ open: z.boolean() }).strict();
export const ViewTicketResponse = z.object({ url: z.string() });

// --- Tasks ---------------------------------------------------------------------------------------------------
// GET  /api/agents/:agentId/tasks?before=<iso>      -> { tasks: Task[], nextBefore: string | null }
// POST /api/agents/:agentId/tasks  { prompt, attachmentIds? }       -> Task
// GET  /api/tasks/:taskId                           -> TaskDetail
// GET  /api/tasks/:taskId/events?after=<seq>        -> text/event-stream of TaskEventEnvelope (SSE id = seq)
// POST /api/tasks/:taskId/reply   { text, attachmentIds? }          -> Task   (answers the open question and resumes)
// POST /api/tasks/:taskId/takeover-done { note }    -> Task   (owner finished; agent resumes)
// POST /api/tasks/:taskId/message { text, attachmentIds? }          -> Task   (follow-up on a finished task: resumes the session)
// POST /api/tasks/:taskId/cancel                    -> Task
// POST /api/tasks/:taskId/events/:seq/reaction { emoji } -> {} (null removes)
export const CreateTaskRequest = z.object({ prompt: z.string().max(20_000), attachmentIds: AttachmentIds }).strict()
  .refine(value => value.prompt.trim().length > 0 || value.attachmentIds.length > 0, "Write a message or attach an image.");
export const ReactionRequest = z.object({ emoji: ReactionEmoji.nullable() }).strict();
export const ReplyRequest = z.object({ text: z.string().max(20_000), attachmentIds: AttachmentIds }).strict()
  .refine(value => value.text.trim().length > 0 || value.attachmentIds.length > 0, "Write a message or attach an image.");
export const TakeoverDoneRequest = z.object({ note: z.string().max(2000).default("") }).strict();

export const TaskPage = z.object({ tasks: z.array(Task), nextBefore: z.string().nullable() });
export type TaskPage = z.infer<typeof TaskPage>;

export const TaskDetail = z.object({
  task: Task,
  runs: z.array(Run),
  openRequests: z.array(OwnerRequest),
  lastSeq: z.number().int(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;
export { TaskEventEnvelope };

// --- Owner images --------------------------------------------------------------------------------------------
// POST /api/agents/:agentId/attachments?name=<filename> -> Attachment (raw PNG, JPEG, GIF or WebP body)
// GET  /api/attachments/:id/content                    -> image bytes (owner session, private inline content)
// Uploads stay unbound until an owner message binds attachmentIds atomically; old unbound uploads expire after 24h.

// --- Files ---------------------------------------------------------------------------------------------------
// GET /api/agents/:agentId/files?scope=downloads|workspace&dir=<RelPath>&cursor= -> FileListing
// GET /api/files/:fileId/content                    -> the bytes, Content-Disposition: attachment, nosniff
// GET /api/agents/:agentId/workspace-file?path=     -> the bytes of a workspace file (attachment)
export const PublishedFile = z.object({
  fileId: FileId,
  name: z.string(),
  bytes: z.number().int(),
  sha256: Sha256Hex,
  mimeType: z.string(),
  sourceUrl: z.string().nullable(),
  taskId: TaskId.nullable(),
  createdAt: z.string(),
});
export type PublishedFile = z.infer<typeof PublishedFile>;
export const FileListing = z.object({
  scope: z.enum(["downloads", "workspace"]),
  dir: RelPath,
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(["file", "dir"]),
      bytes: z.number().int(),
      modifiedAt: z.string(),
      file: PublishedFile.nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type FileListing = z.infer<typeof FileListing>;

export const SafeFileListing = FileListing.superRefine((listing, context) => {
  for (const [index, entry] of listing.entries.entries()) {
    if (!RelPath.safeParse(entry.path).success) {
      context.addIssue({ code: "custom", path: ["entries", index, "path"], message: "expected a path inside the file root" });
    }
  }
});
export type SafeFileListing = z.infer<typeof SafeFileListing>;

// --- Domains ---------------------------------------------------------------------------------------------------
// GET    /api/agents/:agentId/domains               -> DomainsView
// POST   /api/agents/:agentId/domains { pattern, attended } -> DomainRuleView
// DELETE /api/domain-rules/:ruleId
// POST   /api/domain-requests/:requestId/decide { decision, attended } -> DomainsView
export const DomainRuleView = z.object({
  id: z.uuid(),
  pattern: DomainPattern,
  attended: z.boolean(),
  scope: z.enum(["permanent", "task"]),
  taskId: TaskId.nullable(),
  createdAt: z.string(),
});
export type DomainRuleView = z.infer<typeof DomainRuleView>;
export const DomainRequestView = z.object({
  id: DomainRequestId,
  taskId: TaskId.nullable(),
  domains: z.array(DomainPattern),
  reason: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decision: DomainDecision.nullable(),
});
export type DomainRequestView = z.infer<typeof DomainRequestView>;
export const BlockedHostView = z.object({
  host: z.string(),
  decision: EgressDecision,
  count: z.number().int(),
  lastAt: z.string(),
  taskId: TaskId.nullable(),
});
export type BlockedHostView = z.infer<typeof BlockedHostView>;
export const DomainsView = z.object({
  rules: z.array(DomainRuleView),
  pending: z.array(DomainRequestView),
  blocked: z.array(BlockedHostView),
});
export type DomainsView = z.infer<typeof DomainsView>;
export const AddDomainRuleRequest = z.object({ pattern: DomainPattern, attended: z.boolean().default(false) }).strict();
export const DecideDomainRequest = z
  .object({ decision: z.enum(["allow_task", "allow_always", "refuse"]), attended: z.boolean().default(false) })
  .strict();

// --- Audit ---------------------------------------------------------------------------------------------------
// GET /api/agents/:agentId/audit?before=<seq>       -> { events: AuditEvent[], head: { seq, hash } }
// GET /api/agents/:agentId/audit/verify             -> { ok, count, head, failedAtSeq?, reason? }
export const AuditPage = z.object({
  events: z.array(AuditEvent),
  head: z.object({ seq: z.number().int(), hash: z.string() }),
});
export type AuditPage = z.infer<typeof AuditPage>;

export const AuditVerification = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), count: z.number().int().nonnegative(), head: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ ok: z.literal(false), count: z.number().int().nonnegative(), failedAtSeq: z.number().int(), reason: z.string() }),
]);
export type AuditVerification = z.infer<typeof AuditVerification>;

// --- Waiting on the owner (home screen) ---------------------------------------------------------------------------
// GET /api/inbox -> { items: InboxItem[] }
export const InboxItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner_request"), agentId: AgentId, taskTitle: z.string(), request: OwnerRequest }),
  z.object({ kind: z.literal("domain_request"), agentId: AgentId, taskTitle: z.string().nullable(), request: DomainRequestView }),
]);
export type InboxItem = z.infer<typeof InboxItem>;
export const InboxResponse = z.object({ items: z.array(InboxItem) });
export type InboxResponse = z.infer<typeof InboxResponse>;

export { OwnerRequestId };

// --- Desktop app ---------------------------------------------------------------------------------------------------
// The desktop app loads the app origin in its window. It cannot use the Mac's passkeys inside its embedded browser, so it
// signs in, and does the fresh re-check, through the system browser with a short code shown in both places.

// GET /api/desktop/info (no sign-in): lets the desktop app check that a URL is a Quokka Bot server.
export const DesktopInfo = z.object({
  product: z.literal("quokkabot"),
  apiVersion: z.literal(1),
  appOrigin: z.string(),
  viewOrigin: z.string(),
  desktopDownloads: z.boolean(),
  // Older desktop builds than this must update before signing in.
  minDesktopVersion: z.string(),
  // The phone app's routes below (/api/phone/...). Absent on servers older than the iPhone app.
  phoneApi: z.literal(1).optional(),
});
export type DesktopInfo = z.infer<typeof DesktopInfo>;

// POST /api/desktop-link/start (no sign-in). kind "signin" creates a new session for the device when approved; kind
// "fresh" marks the caller's existing session fresh (the caller must be signed in).
export const DesktopLinkStartRequest = z
  .object({ kind: z.enum(["signin", "fresh"]), deviceName: z.string().min(1).max(80) })
  .strict();
export const DesktopLinkStartResponse = z.object({
  // Shown in the app and in the browser; the owner checks they match. Eight characters from an unambiguous alphabet.
  userCode: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
  pollToken: z.string().min(32).max(100),
  // Opened in the default browser: <appOrigin>/link#<userCode>
  verifyUrl: z.string(),
  expiresAt: z.string(),
});
export type DesktopLinkStartResponse = z.infer<typeof DesktopLinkStartResponse>;

// GET /api/desktop-link/pending?code=<userCode> (signed in): what the browser shows before the owner approves.
export const DesktopLinkPending = z.object({
  kind: z.enum(["signin", "fresh"]),
  // Which app asked: the Mac app or the iPhone app (the phone uses the same links, see /api/phone/link/start).
  client: z.enum(["desktop", "phone"]),
  deviceName: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type DesktopLinkPending = z.infer<typeof DesktopLinkPending>;

// Approving takes a passkey assertion bound to this one link (a fresh browser session alone cannot approve links):
// POST /api/desktop-link/approve/options { userCode } -> WebAuthn authentication options (challenge bound to the link
// and the approving browser session); POST /api/desktop-link/approve/verify { userCode, response } -> {} and the link is
// approved. POST /api/desktop-link/refuse { userCode } closes it.
export const DesktopLinkDecideRequest = z.object({ userCode: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/) }).strict();
export const DesktopLinkApproveVerifyRequest = z
  .object({ userCode: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/), response: z.unknown() })
  .strict();

// POST /api/desktop-link/poll (no sign-in). 200 approved: the response sets the session and kill cookies (signin) or the
// caller's session is now fresh (fresh). 202 pending. 410 refused or expired.
export const DesktopLinkPollRequest = z.object({ pollToken: z.string().min(32).max(100) }).strict();
export const DesktopLinkPollResponse = z.object({ state: z.enum(["pending", "approved", "refused", "expired"]) });
export type DesktopLinkPollResponse = z.infer<typeof DesktopLinkPollResponse>;

// --- Phone app -----------------------------------------------------------------------------------------------------
// The iPhone app keeps its session token in the Keychain and sends it as `Authorization: Bearer <token>`. It signs in
// one of three ways: a passkey (only on servers built into the app, since native passkeys need the app's associated
// domain), a link the owner approves in a browser where they are signed in, or a code from the server's operator.
// These routes need no Origin header and read no cookies.

export const PhoneDeviceName = z.string().trim().min(1).max(80);
// Every phone sign-in answers with the new session's token, once.
export const PhoneSessionResponse = z.object({ token: z.string().min(32).max(100) });
export type PhoneSessionResponse = z.infer<typeof PhoneSessionResponse>;

// POST /api/phone/passkey/options: WebAuthn request options and the id of their challenge (the phone has no cookies).
export const PhonePasskeyOptionsResponse = z.object({ challengeId: z.uuid(), options: z.record(z.string(), z.unknown()) });
export type PhonePasskeyOptionsResponse = z.infer<typeof PhonePasskeyOptionsResponse>;
// POST /api/phone/passkey/verify: answers PhoneSessionResponse.
export const PhonePasskeyVerifyRequest = z.object({ challengeId: z.uuid(), response: z.unknown(), deviceName: PhoneDeviceName }).strict();

// POST /api/phone/link/start: answers DesktopLinkStartResponse; the owner approves at its verifyUrl.
export const PhoneLinkStartRequest = z.object({ deviceName: PhoneDeviceName }).strict();
// POST /api/phone/link/poll {pollToken}: 200 approved with the token, 202 pending, 410 refused or expired.
export const PhoneLinkPollResponse = z.discriminatedUnion("state", [
  z.object({ state: z.literal("approved"), token: z.string().min(32).max(100) }),
  z.object({ state: z.enum(["pending", "refused", "expired"]) }),
]);
export type PhoneLinkPollResponse = z.infer<typeof PhoneLinkPollResponse>;

// A code printed on the server by `pairing-code`: twelve characters from the link code alphabet, shown as XXXX-XXXX-XXXX.
// Spaces, dashes and lower case are accepted.
export const PairingCode = z.string().max(40).transform((value) => value.toUpperCase().replace(/[\s-]/g, "")).pipe(z.string().regex(/^[A-HJKMNP-Z2-9]{12}$/));
// POST /api/phone/code: answers PhoneSessionResponse.
export const PhoneCodeRequest = z.object({ code: PairingCode, deviceName: PhoneDeviceName }).strict();

// GET /api/sessions and DELETE /api/sessions/:id: the owner's signed-in devices.
export const SessionView = z.object({
  id: z.string(),
  deviceName: z.string(),
  // The web app, the Mac app or the iPhone app.
  client: z.enum(["browser", "desktop", "phone"]),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  current: z.boolean(),
});
export type SessionView = z.infer<typeof SessionView>;

// GET /api/activity?cursor=<opaque>: tasks that finished after the cursor, oldest first, at most 50 per page; pass the
// returned cursor to continue. Without a cursor: the current position (no items), so a new client starts from now.
export const ActivityItem = z.object({
  taskId: z.string(),
  agentId: z.string(),
  title: z.string(),
  state: z.enum(["completed", "failed", "outcome_unknown", "cancelled"]),
  at: z.string(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;
export const ActivityPage = z.object({ items: z.array(ActivityItem), cursor: z.string(), more: z.boolean() });
export type ActivityPage = z.infer<typeof ActivityPage>;

// POST /api/agents/kill-all: the kill switch for every agent at once, used by the desktop app's menu, tray and shortcut.
// Accepts the kill capability cookie without the database. Each agent's network freeze and sandbox stop are reported
// separately; "confirmed" is true only when both succeeded for every agent.
export const KillAllResult = z.object({
  confirmed: z.boolean(),
  agents: z.array(z.object({ agentId: z.string(), egressFrozen: z.boolean(), sandboxesStopped: z.boolean(), error: z.string().nullable() })),
});
export type KillAllResult = z.infer<typeof KillAllResult>;

// --- Logins (the credential vault) -------------------------------------------------------------------------------
// Values are write-only: the API never returns a password or a 2FA secret, only that they are set and their length.
// GET    /api/agents/:agentId/logins                 -> { logins: LoginView[] }
// POST   /api/agents/:agentId/logins  SaveLoginRequest -> LoginView   (answers an open "login" request for the site)
// PUT    /api/logins/:loginId         UpdateLoginRequest -> LoginView
// DELETE /api/logins/:loginId                         -> {}
export const LoginView = z.object({
  id: z.uuid(),
  agentId: AgentId,
  name: z.string(),
  sites: z.array(DomainPattern),
  username: z.string(),
  passwordLength: z.number().int().min(0),
  hasTotp: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type LoginView = z.infer<typeof LoginView>;
export const SaveLoginRequest = z
  .object({
    name: z.string().min(1).max(80),
    sites: z.array(DomainPattern).min(1).max(20),
    username: z.string().min(1).max(320),
    password: z.string().min(1).max(500),
    // Base32 secret or a full otpauth:// URI from the site's 2FA setup page.
    totp: z.string().min(16).max(1000).optional(),
  })
  .strict();
export const UpdateLoginRequest = z
  .object({
    name: z.string().min(1).max(80).optional(),
    sites: z.array(DomainPattern).min(1).max(20).optional(),
    username: z.string().min(1).max(320).optional(),
    password: z.string().min(1).max(500).optional(),
    totp: z.string().min(16).max(1000).nullable().optional(),
  })
  .strict();

// --- Connected apps --------------------------------------------------------------------------------------------------
// GET    /api/agents/:agentId/connectors              -> ConnectorsResponse
// POST   /api/agents/:agentId/connectors/gmail/start  -> ConnectStartResponse (open `url` in a browser)
// GET    /api/connect/google/callback                 -> HTML page (Google sends the browser back here)
// DELETE /api/connectors/:connectorId                 -> {}
export const ConnectorView = z.object({
  id: z.uuid(),
  agentId: AgentId,
  app: z.enum(["gmail"]),
  account: z.string(),
  connectedAt: z.string(),
});
export type ConnectorView = z.infer<typeof ConnectorView>;
export const ConnectorsResponse = z.object({
  connectors: z.array(ConnectorView),
  // False when this server has no Google OAuth client configured.
  available: z.object({ gmail: z.boolean() }),
});
export type ConnectorsResponse = z.infer<typeof ConnectorsResponse>;
export const ConnectStartResponse = z.object({ url: z.url() });
export type ConnectStartResponse = z.infer<typeof ConnectStartResponse>;
