import { z } from "zod";
import {
  AiConsentRequest, AiConsentView, Attachment, ClaudeSignInCode, ClaudeSignInStart, ClaudeSignInView, AddDomainRuleRequest, AgentSettingsRequest, AgentSummary, AgentsResponse, CreateAgentRequest, ApiError, AttendedRequest,
  AuditPage, AuditVerification, EmptyResponse, FreshAuth, TaskPage, WebAuthnAuthenticationOptions, WebAuthnRegistrationOptions, AuthVerifyRequest, ComputerView, ControlLease, CreateTaskRequest,
  DecideDomainRequest, DomainRuleView, DomainsView, SafeFileListing, InboxResponse, Me,
  RelPath, ReplyRequest, ReactionRequest, type ReactionEmoji, OwnerNameRequest, SetupOptionsRequest, SetupVerifyRequest, TakeoverDoneRequest,
  TakeoverRequest, Task, TaskDetail, TerminalClientFrame, TerminalServerFrame,
  ViewTicketResponse, DesktopLinkPending, DesktopLinkDecideRequest, DesktopLinkApproveVerifyRequest,
  SessionView, LoginView, SaveLoginRequest, UpdateLoginRequest, ConnectorsResponse, ConnectStartResponse, type AgentLook, type Effort } from "@quokkabot/shared";
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
  submitClaudeSignIn: (id: string, code: string) => request(`/claude-sign-in/${encodeURIComponent(id)}/code`, ClaudeSignInView, "POST", ClaudeSignInCode.parse({ code })),
  claudeSignIn: () => request("/claude-sign-in", ClaudeSignInView),
  signOutClaude: () => request("/claude-sign-in", ClaudeSignInView, "DELETE"),
  cancelClaudeSignIn: (id: string) => request(`/claude-sign-in/${encodeURIComponent(id)}`, EmptyResponse, "DELETE"),
  me: () => request("/me", Me),
  setOwnerName: (ownerName: string) => request("/me", Me, "PUT", OwnerNameRequest.parse({ ownerName })),
  setupOptions: async (ticket: string) => await request("/setup/options", WebAuthnRegistrationOptions, "POST", SetupOptionsRequest.parse({ ticket })) as PublicKeyCredentialCreationOptionsJSON,
  setupVerify: (ticket: string, response: unknown) => request("/setup/verify", Me, "POST", SetupVerifyRequest.parse({ ticket, response })),
  authOptions: async (fresh = false) => await request(fresh ? "/auth/fresh/options" : "/auth/options", WebAuthnAuthenticationOptions, "POST", {}) as PublicKeyCredentialRequestOptionsJSON,
  authVerify: (response: unknown) => request("/auth/verify", Me, "POST", AuthVerifyRequest.parse({ response })),
  freshVerify: (response: unknown) => request("/auth/fresh/verify", FreshAuth, "POST", AuthVerifyRequest.parse({ response })),
  logout: () => request("/auth/logout", EmptyResponse, "POST", {}),
  desktopLink: (userCode: string) => request(`/desktop-link/pending${queryString({ code: DesktopLinkDecideRequest.parse({ userCode }).userCode })}`, DesktopLinkPending),
  desktopLinkOptions: async (userCode: string) => await request("/desktop-link/approve/options", WebAuthnAuthenticationOptions, "POST", DesktopLinkDecideRequest.parse({ userCode })) as PublicKeyCredentialRequestOptionsJSON,
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
  inbox: () => request("/inbox", InboxResponse),
  aiConsent: (id: string) => request(`${agentPath(id)}/ai-consent`, AiConsentView),
  setAiConsent: (id: string, input: AiConsentRequest) => request(`${agentPath(id)}/ai-consent`, AiConsentView, "PUT", AiConsentRequest.parse(input)),
  // Sends only the fields given: a setting another app changed a moment ago stays as it is.
  settings: async (id: string, changes: { name?: string | undefined; model?: string | undefined; effort?: Effort | undefined; look?: AgentLook | null | undefined }) => rememberAgent(await request(`${agentPath(id)}/settings`, AgentSummary, "PUT", AgentSettingsRequest.parse(changes))),
  // Sends only the name: a model or effort changed in another app a moment ago stays as it is.
  rename: async (id: string, name: string) => rememberAgent(await request(`${agentPath(id)}/settings`, AgentSummary, "PUT", AgentSettingsRequest.parse({ name }))),
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
