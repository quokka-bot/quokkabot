import { z } from "zod";
import {
  Attachment, ClaudeSignInCode, ClaudeSignInStart, ClaudeSignInStatus, AddDomainRuleRequest, AgentSettingsRequest, AgentSummary, AgentsResponse, CreateAgentRequest, ApiError, AttendedRequest,
  AuditPage, AuthVerifyRequest, ComputerView, ControlLease, CreateTaskRequest,
  DecideDomainRequest, DomainRuleView, DomainsView, FileListing, InboxItem, Me,
  RelPath, ReplyRequest, ReactionRequest, type ReactionEmoji, SetupOptionsRequest, SetupVerifyRequest, TakeoverDoneRequest,
  TakeoverRequest, Task, TaskDetail, TaskEventEnvelope, TerminalClientFrame, TerminalServerFrame,
  ViewTicketResponse, DesktopLinkPending, DesktopLinkDecideRequest, DesktopLinkApproveVerifyRequest,
  SessionView, LoginView, SaveLoginRequest, UpdateLoginRequest, ConnectorsResponse, ConnectStartResponse } from "@quokkabot/shared";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

export const UNAUTHORIZED_EVENT = "quokkabot:unauthorized";

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ApiFailure";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validate<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${context}: invalid response at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}

// These wire shapes have route comments but no shared response schemas yet.
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
const AuthenticationOptions = z.object({
  challenge: z.string().min(1), timeout: z.number().positive().optional(), rpId: z.string().min(1).optional(),
  allowCredentials: z.array(CredentialDescriptor).optional(), userVerification: UserVerification.optional(),
  hints: CredentialHints.optional(), extensions: AuthenticationExtensions.optional(),
}).passthrough();
const RegistrationOptions = z.object({
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
const FreshAuth = z.object({ freshUntil: z.string().datetime({ offset: true }) });
const EmptyResponse = z.union([z.null(), z.object({}).strict()]);
const AuditVerification = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), count: z.number().int().nonnegative(), head: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ ok: z.literal(false), count: z.number().int().nonnegative(), failedAtSeq: z.number().int(), reason: z.string() }),
]);
const Inbox = z.object({ items: z.array(InboxItem) });
const TaskPage = z.object({ tasks: z.array(Task), nextBefore: z.string().nullable() });
const SafeFileListing = FileListing.superRefine((listing, context) => {
  for (const [index, entry] of listing.entries.entries()) {
    if (!RelPath.safeParse(entry.path).success) {
      context.addIssue({ code: "custom", path: ["entries", index, "path"], message: "expected a path inside the file root" });
    }
  }
});

const agentGenerations = new Map<string, number>();
function agentHeaders(path: string): Record<string, string> {
  const match = /^\/agents\/([^/?]+)(?:\/|\?|$)/.exec(path);
  const generation = match?.[1] ? agentGenerations.get(decodeURIComponent(match[1])) : undefined;
  return generation === undefined ? {} : { "X-Quokkabot-Agent-Generation": String(generation) };
}
function rememberAgent(agent: AgentSummary): AgentSummary {
  agentGenerations.set(agent.id, agent.generation);
  return agent;
}

async function fetchResponse(path: string, method: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  extraHeaders = { ...agentHeaders(path), ...extraHeaders };
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method, credentials: "same-origin",
      ...(body === undefined
        ? (Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : {})
        : { headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new Error(`${method} ${path}: ${errorMessage(error)}`);
  }
  // Notify before decoding: expired sessions must route to sign-in even if an edge returned a non-JSON 401.
  if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  return response;
}

async function readJson(response: Response, method: string, path: string): Promise<unknown> {
  let data: unknown;
  try {
    data = response.status === 204 ? null : await response.json();
  } catch {
    throw new ApiFailure(`${method} ${path}: expected JSON (HTTP ${response.status})`, response.status, "invalid_json");
  }
  if (!response.ok) {
    const error = ApiError.safeParse(data);
    if (!error.success) throw new ApiFailure(`${method} ${path}: invalid error response (HTTP ${response.status})`, response.status, "invalid_error");
    throw new ApiFailure(error.data.error.message, response.status, error.data.error.code);
  }
  return data;
}

async function request<T>(path: string, schema: z.ZodType<T>, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetchResponse(path, method, body, headers);
  const data = await readJson(response, method, path);
  return validate(schema, data, `${method} ${path}`);
}

const agentPath = (id: string) => `/agents/${encodeURIComponent(id)}`;
const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;
const queryString = (values: Record<string, string | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, value);
  return `?${params.toString()}`;
};

export const api = {
  startClaudeSignIn: (id: string) => request(`${agentPath(id)}/claude-sign-in`, ClaudeSignInStart, "POST", {}),
  submitClaudeSignIn: (id: string, code: string) => request(`/claude-sign-in/${encodeURIComponent(id)}/code`, ClaudeSignInStatus, "POST", ClaudeSignInCode.parse({ code })),
  cancelClaudeSignIn: (id: string) => request(`/claude-sign-in/${encodeURIComponent(id)}`, EmptyResponse, "DELETE"),
  me: () => request("/me", Me),
  setupOptions: async (ticket: string) => await request("/setup/options", RegistrationOptions, "POST", SetupOptionsRequest.parse({ ticket })) as PublicKeyCredentialCreationOptionsJSON,
  setupVerify: (ticket: string, response: unknown) => request("/setup/verify", Me, "POST", SetupVerifyRequest.parse({ ticket, response })),
  authOptions: async (fresh = false) => await request(fresh ? "/auth/fresh/options" : "/auth/options", AuthenticationOptions, "POST", {}) as PublicKeyCredentialRequestOptionsJSON,
  authVerify: (response: unknown) => request("/auth/verify", Me, "POST", AuthVerifyRequest.parse({ response })),
  freshVerify: (response: unknown) => request("/auth/fresh/verify", FreshAuth, "POST", AuthVerifyRequest.parse({ response })),
  logout: () => request("/auth/logout", EmptyResponse, "POST", {}),
  desktopLink: (userCode: string) => request(`/desktop-link/pending${queryString({ code: DesktopLinkDecideRequest.parse({ userCode }).userCode })}`, DesktopLinkPending),
  desktopLinkOptions: async (userCode: string) => await request("/desktop-link/approve/options", AuthenticationOptions, "POST", DesktopLinkDecideRequest.parse({ userCode })) as PublicKeyCredentialRequestOptionsJSON,
  approveDesktopLink: (userCode: string, response: unknown) => request("/desktop-link/approve/verify", EmptyResponse, "POST", DesktopLinkApproveVerifyRequest.parse({ userCode, response })),
  refuseDesktopLink: (userCode: string) => request("/desktop-link/refuse", EmptyResponse, "POST", DesktopLinkDecideRequest.parse({ userCode })),
  sessions: () => request("/sessions", z.object({ sessions: z.array(SessionView) })),
  signOutSession: (id: string) => request(`/sessions/${encodeURIComponent(id)}`, EmptyResponse, "DELETE"),
  connectors: (id: string) => request(`${agentPath(id)}/connectors`, ConnectorsResponse),
  startGmail: (id: string) => request(`${agentPath(id)}/connectors/gmail/start`, ConnectStartResponse, "POST", {}),
  removeConnector: (id: string) => request(`/connectors/${encodeURIComponent(id)}`, EmptyResponse, "DELETE"),
  logins: (id: string) => request(`${agentPath(id)}/logins`, z.object({ logins: z.array(LoginView) })),
  saveLogin: (id: string, input: z.input<typeof SaveLoginRequest>) => request(`${agentPath(id)}/logins`, LoginView, "POST", SaveLoginRequest.parse(input)),
  updateLogin: (id: string, input: z.input<typeof UpdateLoginRequest>) => request(`/logins/${encodeURIComponent(id)}`, LoginView, "PUT", UpdateLoginRequest.parse(input)),
  deleteLogin: (id: string) => request(`/logins/${encodeURIComponent(id)}`, EmptyResponse, "DELETE"),
  agents: async () => {
    const result = await request("/agents", AgentsResponse);
    for (const agent of result.agents) rememberAgent(agent);
    return result;
  },
  createAgent: async (name: string) => rememberAgent(await request("/agents", AgentSummary, "POST", CreateAgentRequest.parse({ name }))),
  removeAgent: (id: string) => request(agentPath(id), EmptyResponse, "DELETE"),
  agent: async (id: string) => rememberAgent(await request(agentPath(id), AgentSummary)),
  inbox: () => request("/inbox", Inbox),
  settings: async (id: string, model: string, effort: string, name?: string) => rememberAgent(await request(`${agentPath(id)}/settings`, AgentSummary, "PUT", AgentSettingsRequest.parse({ model, effort, ...(name === undefined ? {} : { name }) }))),
  computer: (id: string, action: "start" | "stop") => request(`${agentPath(id)}/computer/${action}`, ComputerView, "POST", {}),
  kill: (id: string) => request(`${agentPath(id)}/kill`, ComputerView, "POST", {}),
  releaseKill: (id: string) => request(`${agentPath(id)}/kill/release`, ComputerView, "POST", {}),
  takeover: (id: string, action: "take" | "return") => request(`${agentPath(id)}/takeover`, ControlLease, "POST", TakeoverRequest.parse({ action })),
  attended: (id: string, open: boolean) => request(`${agentPath(id)}/attended`, ComputerView, "POST", AttendedRequest.parse({ open })),
  viewTicket: async (id: string) => {
    const ticket = await request(`${agentPath(id)}/view-ticket`, ViewTicketResponse, "POST", {});
    const url = new URL(ticket.url, window.location.origin);
    // HTTPS, except a *.localhost viewer while the app itself runs on http://localhost (development).
    const developmentHttp = window.location.protocol === "http:" && url.protocol === "http:" && isLocalhost(url.hostname);
    if ((url.protocol !== "https:" && !developmentHttp) || url.origin === window.location.origin || url.username || url.password) {
      throw new Error("View ticket: expected an HTTPS URL on a separate viewer origin");
    }
    return { url: url.href };
  },
  uploadImage: async (id: string, image: File): Promise<Attachment> => {
    const path = `${agentPath(id)}/attachments${queryString({ name: image.name })}`;
    const response = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": image.type, ...agentHeaders(path) }, body: image });
    if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    return validate(Attachment, await readJson(response, "POST", path), "Image upload");
  },
  tasks: (id: string, before?: string) => request(`${agentPath(id)}/tasks${queryString({ before })}`, TaskPage),
  // The key makes a repeated submit (double Enter, a retry after a lost reply) return the same task.
  createTask: (id: string, prompt: string, idempotencyKey: string, attachmentIds: string[] = []) => request(`${agentPath(id)}/tasks`, Task, "POST", CreateTaskRequest.parse({ prompt, attachmentIds }), { "Idempotency-Key": idempotencyKey }),
  task: (id: string) => request(taskPath(id), TaskDetail),
  reply: (id: string, text: string, attachmentIds: string[] = []) => request(`${taskPath(id)}/reply`, Task, "POST", ReplyRequest.parse({ text, attachmentIds })),
  react: (taskId: string, seq: number, emoji: ReactionEmoji | null) => request(`${taskPath(taskId)}/events/${seq}/reaction`, EmptyResponse, "POST", ReactionRequest.parse({ emoji })),
  signInMyself: (requestId: string) => request(`/owner-requests/${encodeURIComponent(requestId)}/sign-in-myself`, z.object({}), "POST", {}),
  takeoverDone: (id: string, note: string) => request(`${taskPath(id)}/takeover-done`, Task, "POST", TakeoverDoneRequest.parse({ note })),
  message: (id: string, text: string, attachmentIds: string[] = []) => request(`${taskPath(id)}/message`, Task, "POST", ReplyRequest.parse({ text, attachmentIds })),
  cancel: (id: string) => request(`${taskPath(id)}/cancel`, Task, "POST", {}),
  files: (id: string, scope: "downloads" | "workspace", dir: string, cursor?: string) => request(`${agentPath(id)}/files${queryString({ scope, dir: RelPath.parse(dir), cursor })}`, SafeFileListing),
  domains: (id: string) => request(`${agentPath(id)}/domains`, DomainsView),
  addDomain: (id: string, pattern: string, attended: boolean) => request(`${agentPath(id)}/domains`, DomainRuleView, "POST", AddDomainRuleRequest.parse({ pattern, attended })),
  removeDomain: (id: string) => request(`/domain-rules/${encodeURIComponent(id)}`, EmptyResponse, "DELETE"),
  decideDomain: (id: string, decision: "allow_task" | "allow_always" | "refuse", attended: boolean) => request(`/domain-requests/${encodeURIComponent(id)}/decide`, DomainsView, "POST", DecideDomainRequest.parse({ decision, attended })),
  audit: (id: string, before?: number) => request(`${agentPath(id)}/audit${queryString({ before: before?.toString() })}`, AuditPage),
  verifyAudit: (id: string) => request(`${agentPath(id)}/audit/verify`, AuditVerification),
  downloadFile: async (url: string, name: string) => {
    if (!url.startsWith("/api/")) throw new Error("File download: expected a same-origin API path");
    const path = url.slice(4);
    const response = await fetchResponse(path, "GET");
    if (!response.ok) await readJson(response, "GET", path);
    if (!response.headers.get("Content-Disposition")?.toLowerCase().startsWith("attachment")) {
      throw new Error("File download: response is missing attachment disposition");
    }
    if (response.headers.get("X-Content-Type-Options")?.toLowerCase() !== "nosniff") {
      throw new Error("File download: response is missing nosniff protection");
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = name.replace(/[\u0000-\u001f/\\]/g, "_");
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  },
};

export const fileDownloadUrl = (id: string) => `/api/files/${encodeURIComponent(id)}/content`;
export const workspaceDownloadUrl = (id: string, path: string) => `/api${agentPath(id)}/workspace-file${queryString({ path: RelPath.parse(path) })}`;
export const taskEventsUrl = (id: string, after: number) => `/api${taskPath(id)}/events?after=${after}`;
export const parseTaskEvent = (data: string) => validate(TaskEventEnvelope, JSON.parse(data) as unknown, "Task event");
export const parseTerminalFrame = (data: string) => validate(TerminalServerFrame, JSON.parse(data) as unknown, "Terminal frame");
export const encodeTerminalFrame = (frame: TerminalClientFrame) => JSON.stringify(TerminalClientFrame.parse(frame));
export function terminalUrl(id: string, location: Pick<Location, "origin" | "protocol"> = window.location): string {
  const url = new URL(`/api${agentPath(id)}/terminal`, location.origin);
  // wss everywhere, except plain ws when the app runs on http://localhost (development).
  url.protocol = location.protocol === "http:" && isLocalhost(url.hostname) ? "ws:" : "wss:";
  return url.href;
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

export const attachmentContentUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}/content`;
