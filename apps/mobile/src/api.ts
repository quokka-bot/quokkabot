import { z } from "zod";
import {
  AgentSummary, AgentsResponse, ApiError, AttendedRequest, ComputerView, ControlLease, CreateTaskRequest, DecideDomainRequest, DomainsView, EmptyResponse,
  InboxResponse, LoginView, Me, ReactionRequest, type ReactionEmoji, ReplyRequest, SaveLoginRequest, SessionView,
  TakeoverDoneRequest, TakeoverFillRequest, TakeoverFillResponse, TakeoverFocusResponse, TakeoverRequest, Task, TaskDetail,
  TaskPage, UpdateLoginRequest, ViewTicketResponse,
} from "@quokkabot/shared";

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ApiFailure";
  }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number; ok: boolean; json(): Promise<unknown>;
}>;

function validate<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${context}: invalid response at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}

// One request to the server, with or without the phone's session. Answers are checked against the shared schemas;
// errors carry the server's code and message.
export async function call<T>(fetchImpl: Fetch, origin: string, path: string, schema: z.ZodType<T>, opts: {
  method?: string; body?: unknown; token?: string | undefined; headers?: Record<string, string>;
} = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Awaited<ReturnType<Fetch>>;
  try {
    response = await fetchImpl(`${origin}/api${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  } catch (error) {
    throw new Error(`Could not reach ${new URL(origin).host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let data: unknown = null;
  try { data = response.status === 204 ? null : await response.json(); }
  catch { throw new ApiFailure(`${method} ${path}: the server did not answer with JSON (HTTP ${response.status})`, response.status, "invalid_json"); }
  if (!response.ok) {
    const error = ApiError.safeParse(data);
    if (!error.success) throw new ApiFailure(`${method} ${path}: HTTP ${response.status}`, response.status, "invalid_error");
    throw new ApiFailure(error.data.error.message, response.status, error.data.error.code);
  }
  return validate(schema, data, `${method} ${path}`);
}

const agentPath = (id: string) => `/agents/${encodeURIComponent(id)}`;
const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;

// The signed-in API. Every request carries the session token; a 401 means this phone was signed out (revoked in
// Settings, expired), and onSignedOut drops the connection. Agent requests carry the agent's generation, as the
// web app's do, so a reused agent slot never receives a request meant for the agent that was removed.
export function createApi(fetchImpl: Fetch, origin: string, token: string, onSignedOut: () => void) {
  const generations = new Map<string, number>();
  const remember = (agent: AgentSummary): AgentSummary => { generations.set(agent.id, agent.generation); return agent; };
  async function request<T>(path: string, schema: z.ZodType<T>, method = "GET", body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const agentId = /^\/agents\/([^/?]+)/.exec(path)?.[1];
    const generation = agentId === undefined ? undefined : generations.get(decodeURIComponent(agentId));
    const headers = { ...(generation === undefined ? {} : { "X-Quokkabot-Agent-Generation": String(generation) }), ...extra };
    try {
      return await call(fetchImpl, origin, path, schema, { method, body, token, headers });
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) onSignedOut();
      throw error;
    }
  }
  return {
    origin,
    me: () => request("/me", Me),
    logout: () => request("/auth/logout", EmptyResponse, "POST", {}),
    sessions: () => request("/sessions", z.object({ sessions: z.array(SessionView) })),
    agents: async () => {
      const result = await request("/agents", AgentsResponse);
      for (const agent of result.agents) remember(agent);
      return result;
    },
    agent: async (id: string) => remember(await request(agentPath(id), AgentSummary)),
    inbox: () => request("/inbox", InboxResponse),
    tasks: (id: string) => request(`${agentPath(id)}/tasks`, TaskPage),
    task: (id: string) => request(taskPath(id), TaskDetail),
    createTask: (id: string, prompt: string, idempotencyKey: string) => request(`${agentPath(id)}/tasks`, Task, "POST", CreateTaskRequest.parse({ prompt, attachmentIds: [] }), { "Idempotency-Key": idempotencyKey }),
    reply: (id: string, text: string) => request(`${taskPath(id)}/reply`, Task, "POST", ReplyRequest.parse({ text, attachmentIds: [] })),
    message: (id: string, text: string) => request(`${taskPath(id)}/message`, Task, "POST", ReplyRequest.parse({ text, attachmentIds: [] })),
    cancel: (id: string) => request(`${taskPath(id)}/cancel`, Task, "POST", {}),
    react: (taskId: string, seq: number, emoji: ReactionEmoji | null) => request(`${taskPath(taskId)}/events/${seq}/reaction`, EmptyResponse, "POST", ReactionRequest.parse({ emoji })),
    takeover: (id: string, action: "take" | "return") => request(`${agentPath(id)}/takeover`, ControlLease, "POST", TakeoverRequest.parse({ action })),
    takeoverDone: (taskId: string) => request(`${taskPath(taskId)}/takeover-done`, Task, "POST", TakeoverDoneRequest.parse({ note: "" })),
    signInMyself: (requestId: string) => request(`/owner-requests/${encodeURIComponent(requestId)}/sign-in-myself`, z.object({}), "POST", {}),
    logins: (id: string) => request(`${agentPath(id)}/logins`, z.object({ logins: z.array(LoginView) })),
    saveLogin: (id: string, input: z.input<typeof SaveLoginRequest>) => request(`${agentPath(id)}/logins`, LoginView, "POST", SaveLoginRequest.parse(input)),
    updateLogin: (id: string, input: z.input<typeof UpdateLoginRequest>) => request(`/logins/${encodeURIComponent(id)}`, LoginView, "PUT", UpdateLoginRequest.parse(input)),
    decideDomain: (id: string, decision: "allow_task" | "allow_always" | "refuse", attended: boolean) => request(`/domain-requests/${encodeURIComponent(id)}/decide`, DomainsView, "POST", DecideDomainRequest.parse({ decision, attended })),
    startComputer: (id: string) => request(`${agentPath(id)}/computer/start`, ComputerView, "POST", {}),
    // The kill switch: closes the agent's network and stops its sandboxes. Releasing it needs a passkey check on the web.
    kill: (id: string) => request(`${agentPath(id)}/kill`, ComputerView, "POST", {}),
    // The attended session: sites approved "only while I watch" (government, banks) are reachable while it is open.
    attended: (id: string, open: boolean) => request(`${agentPath(id)}/attended`, ComputerView, "POST", AttendedRequest.parse({ open })),
    // During the owner's takeover: which field is focused on the computer (its site and kind, never its value), and
    // typing the phone's native field into it.
    takeoverFocus: (id: string) => request(`${agentPath(id)}/takeover/focus`, TakeoverFocusResponse),
    takeoverFill: (id: string, input: z.input<typeof TakeoverFillRequest>) => request(`${agentPath(id)}/takeover/fill`, TakeoverFillResponse, "POST", TakeoverFillRequest.parse(input)),
    // The live view's one-time URL on the server's viewer origin; the phone opens nothing else in its viewer.
    viewTicket: async (id: string, viewOrigin: string) => {
      const ticket = await request(`${agentPath(id)}/view-ticket`, ViewTicketResponse, "POST", {});
      const url = new URL(ticket.url);
      if (url.origin !== viewOrigin || url.username || url.password) throw new Error("The server's view link is not on its viewer address.");
      return url.href;
    },
  };
}
export type Api = ReturnType<typeof createApi>;
