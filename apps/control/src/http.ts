import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import type { Duplex } from "node:stream";
import { join, normalize } from "node:path";
import {
  AddDomainRuleRequest,
  AgentSettingsRequest,
  CreateAgentRequest,
  type AgentSummary,
  AttendedRequest,
  AuthVerifyRequest,
  CreateTaskRequest,
  ImageMediaType,
  MAX_IMAGE_BYTES,
  DesktopLinkApproveVerifyRequest,
  DesktopLinkDecideRequest,
  DesktopLinkPollRequest,
  DesktopLinkStartRequest,
  PhoneCodeRequest,
  PhoneLinkStartRequest,
  PhonePasskeyVerifyRequest,
  DecideDomainRequest,
  type DomainRequestId,
  type DomainsView,
  type FileListing,
  type InboxItem,
  RelPath,
  ReplyRequest,
  ReactionRequest,
  SaveLoginRequest,
  UpdateLoginRequest,
  SetupOptionsRequest,
  SetupVerifyRequest,
  TakeoverDoneRequest,
  TakeoverRequest,
  TakeoverFillRequest,
  TakeoverScreenRequest,
  TerminalClientFrame,
  siteLabel,
} from "@quokkabot/shared";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import WebSocket, { WebSocketServer } from "ws";
import type { z } from "zod";
import { attachmentContent, attachmentHeaders, uploadAttachment } from "./attachments.js";
import type { AuditLog } from "./audit.js";
import type { AgentSlots } from "./agents.js";
import { Auth, CHALLENGE_COOKIE, KILL_COOKIE, SESSION_COOKIE, type SessionInfo, VIEW_COOKIE, isFresh, killCapability, killCapabilityValid } from "./auth.js";
import { UpstreamError, type SupervisorClient } from "./clients.js";
import type { AgentHandles, ComputerService } from "./computer.js";
import type { ControlConfig } from "./config.js";
import type { DesktopLinks } from "./desktop.js";
import type { PairingCodes } from "./pairing.js";
import type { Vault } from "./vault.js";
import type { Connectors } from "./connectors.js";
import { ClaudeSignIns } from "./claude-sign-in.js";
import { aboutPage, connectedPage, privacyPage } from "./pages.js";
import { type Db, many, maybeOne, one } from "./db.js";
import { HttpError } from "./errors.js";
import { serializeRequest } from "./logging.js";
import type { TaskEvents } from "./events.js";
import type { PolicyService } from "./policy.js";
import { type OwnerRequestRow, type RunRow, type TaskRow, type TaskService, ownerRequestView, runView, taskView } from "./tasks.js";

export interface HttpDeps {
  config: ControlConfig;
  slots: AgentSlots;
  desktopLinks: DesktopLinks;
  pairingCodes: PairingCodes;
  vault: Vault;
  connectors: Connectors;
  db: Db;
  auth: Auth;
  audit: AuditLog;
  tasks: TaskService;
  events: TaskEvents;
  computer: ComputerService;
  policy: PolicyService;
  supervisor: SupervisorClient;
  drainTools: (agentId: string) => Promise<void>;
  handles: (agentId: string) => AgentHandles;
  log: Logger;
  webRoot: string;
}

// Cursor timestamps keep PostgreSQL's microseconds; a JavaScript Date would drop them and repeat the last item.
const CURSOR_AT = `to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// Desktop builds older than this must update: the API they need changed.
const MIN_DESKTOP_VERSION = "0.1.0";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new HttpError(400, "invalid_request", result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return result.data;
}

// Whether a request or upgrade sends an Authorization header at all; when it does, it must be a phone's bearer token.
function hasAuthorization(request: { headers: http.IncomingHttpHeaders }): boolean {
  return request.headers.authorization !== undefined;
}
// The token of an `Authorization: Bearer <token>` header; anything else is no token, so the request is signed out.
function bearerToken(request: { headers: http.IncomingHttpHeaders }): string | undefined {
  return /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.authorization ?? "")?.[1];
}

function uuidParam(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new HttpError(404, `unknown_${what}`, `No such ${what}.`);
  return value;
}

declare module "fastify" {
  interface FastifyContextConfig {
    // A phone sign-in route: it may be called without an Origin header (a native app has none) and reads no cookies.
    phoneSignIn?: boolean;
  }
  interface FastifyRequest {
    session: SessionInfo | null;
    releaseAgent: (() => void) | null;
    agentHandlerRunning: boolean;
  }
}

export async function buildServer(deps: HttpDeps): Promise<{ app: FastifyInstance; server: http.Server }> {
  const { config, slots, db, auth, tasks, events, computer, policy, supervisor, handles, log, audit, desktopLinks, pairingCodes, vault, connectors } = deps;
  // Fastify ignores its serializers option when loggerInstance is supplied, so enforce it on the child logger.
  const requestLog = log.child({}, { serializers: { req: serializeRequest } });
  const app = Fastify({ loggerInstance: requestLog as never, trustProxy: true, bodyLimit: 1024 * 1024 }) as unknown as FastifyInstance;
  void app.register(cookie);
  // Requests per client address (Caddy passes it on). Every route has a ceiling; the routes that work without a
  // session (setup, sign-in, desktop link, OAuth callback) have a tight one.
  // Awaited and first: the plugin attaches its limit to each route as the route is added, so it is loaded before any
  // route or hook. Each route checks its limit in onRequest, before the preHandler hook below reads a session.
  await app.register(rateLimit, {
    global: true,
    max: 1200,
    timeWindow: "1 minute",
    errorResponseBuilder: (_request, context) => new HttpError(429, "rate_limited", `Too many requests. Try again in ${context.after}.`),
  });
  app.decorateRequest("session", null);
  app.addContentTypeParser(ImageMediaType.options, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.decorateRequest("releaseAgent", null);
  app.decorateRequest("agentHandlerRunning", false);
  const secureCookies = config.appOrigin.startsWith("https://");
  const claudeSignIns = new ClaudeSignIns(db, supervisor, computer, audit, slots);

  function releaseAgent(request: FastifyRequest): void {
    if (request.agentHandlerRunning) return;
    request.releaseAgent?.();
    request.releaseAgent = null;
  }
  app.addHook("onRoute", (route) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      request.agentHandlerRunning = true;
      // Response hooks can be skipped on disconnect, or run before an early-sending handler finishes.
      try { return await handler.call(this, request, reply); }
      finally {
        request.agentHandlerRunning = false;
        releaseAgent(request);
      }
    };
  });

  async function agentParam(value: unknown): Promise<string> {
    const id = uuidParam(value, "agent");
    await slots.require(id);
    return id;
  }

  app.addHook("preHandler", async (request) => {
    const params = request.params as Record<string, string>;
    if (!params) return;
    // Resource-id routes need the same slot check as /agents/:agentId, including old rows for removed slots.
    const resource = params.taskId ? ["tasks", params.taskId] : params.fileId ? ["files", params.fileId]
      : params.loginId ? ["logins", params.loginId] : params.connectorId ? ["connectors", params.connectorId]
      : params.ruleId ? ["domain_rules", params.ruleId]
      : params.requestId ? [request.url.startsWith("/api/domain-requests/") ? "domain_requests" : "owner_requests", params.requestId] : null;
    let agentId = params.agentId;
    if (resource) {
      await requireSession(request);
      const row = await maybeOne<{ agent_id: string }>(db, resource[0] === "owner_requests"
        ? "select t.agent_id from owner_requests o join tasks t on t.id = o.task_id where o.id = $1"
        : `select agent_id from ${resource[0]} where id = $1`, [uuidParam(resource[1], "resource")]);
      if (row) agentId = row.agent_id;
    }
    const generation = request.headers["x-quokkabot-agent-generation"];
    // The kill switch never waits for the agent lock or the database: killing is right for whichever agent holds the
    // slot.
    if (!agentId || request.routeOptions.url?.endsWith("/kill")) return;
    if (request.method !== "GET" && request.method !== "HEAD") {
      await requireSession(request);
      const removing = request.method === "DELETE" && request.routeOptions.url === "/api/agents/:agentId";
      // Removal checks the generation inside its own exclusive operation.
      if (removing) return;
      request.releaseAgent = await slots.acquire(agentId);
      await slots.require(agentId, request.routeOptions.url?.endsWith("/kill/release") === true,
        Array.isArray(generation) ? generation.join(",") : generation);
    } else if (resource) await slots.require(agentId);
  });
  app.addHook("onSend", async (request, _reply, payload) => { releaseAgent(request); return payload; });
  app.addHook("onResponse", async (request) => { releaseAgent(request); });

  app.setErrorHandler((rawError, request, reply) => {
    releaseAgent(request);
    const error = rawError as Error & { statusCode?: number };
    if (error instanceof HttpError) {
      void reply.status(error.status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const status = error.statusCode;
    if (status && status >= 400 && status < 500) {
      void reply.status(status).send({ error: { code: "bad_request", message: error.message } });
      return;
    }
    request.log.error({ err: error }, "request failed");
    void reply.status(500).send({ error: { code: "internal", message: "The server hit an error. It is in the log." } });
  });

  // Host routing: the owner app and the viewer are different origins served by this one process.
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (host !== config.appHost && host !== config.viewHost) {
      await reply.status(421).send({ error: { code: "wrong_host", message: "Unknown host." } });
      return reply;
    }
    if (host === config.appHost) {
      void reply.headers({
        "content-security-policy": `default-src 'self'; frame-src ${config.viewOrigin}; connect-src 'self' ${config.appOrigin.startsWith("https:") ? "wss" : "ws"}://${config.appHost}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cross-origin-opener-policy": "same-origin",
      });
      const method = request.method;
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        // Every state change must come from the app's own pages, or from the phone app: with its token in the
        // Authorization header, or on a phone sign-in route, which reads no cookies. A web page cannot send that header
        // to this origin: the browser would ask first (a CORS preflight), and this server never allows it. An Origin,
        // when sent, must be the app's own.
        const origin = request.headers.origin;
        const nativeClient = hasAuthorization(request) || request.routeOptions.config?.phoneSignIn === true;
        if (origin === undefined ? !nativeClient : origin !== config.appOrigin) {
          await reply.status(403).send({ error: { code: "bad_origin", message: "Request refused: wrong origin." } });
          return reply;
        }
      }
    }
    return undefined;
  });

  const appRoute = { constraints: { host: config.appHost } };
  const signInRoute = { ...appRoute, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  const viewRoute = { constraints: { host: config.viewHost } };

  // A request carries one credential. With an Authorization header (the phone app), its bearer token is the only
  // one: every cookie is ignored, the session and kill cookies included. Without it, the session cookie (the web and
  // Mac apps). Each kind of session is accepted only the way it travels (Auth.session).
  async function requireSession(request: FastifyRequest): Promise<SessionInfo> {
    const session = hasAuthorization(request)
      ? await auth.session(bearerToken(request), "bearer")
      : await auth.session(request.cookies[SESSION_COOKIE], "cookie");
    if (!session) throw new HttpError(401, "signed_out", "Sign in.");
    request.session = session;
    return session;
  }
  // The owner's cookies on the app host, or none when the request authenticates with a bearer token.
  function ownerCookie(request: FastifyRequest, name: string): string | undefined {
    return hasAuthorization(request) ? undefined : request.cookies[name];
  }

  function setSessionCookie(reply: FastifyReply, token: string): void {
    void reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: secureCookies, sameSite: "strict", path: "/", maxAge: 30 * 24 * 3600 });
    void reply.setCookie(KILL_COOKIE, killCapability(config.secrets.sessionSecret, 30), {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "strict",
      path: "/api/agents/",
      maxAge: 30 * 24 * 3600,
    });
  }

  // Live terminal and viewer connections, by the owner session that opened them. A revoked or expired session closes
  // its connections; the viewer sockets also tell whether the owner can still see a takeover.
  // An entry may carry its own check besides the owner session (a viewer's 12-hour cookie); the sweep closes it when
  // either fails. The checks only read: an open connection never extends a session.
  type Relay = { agentId: string; kind: "terminal" | "viewer" | "stream"; close: () => void; alive?: (() => Promise<boolean>) | undefined };
  const relays = new Map<string, Set<Relay>>();
  function track(sessionHash: string, agentId: string, kind: Relay["kind"], close: () => void, alive?: () => Promise<boolean>): () => void {
    const entry: Relay = { agentId, kind, close, alive };
    const set = relays.get(sessionHash) ?? new Set();
    set.add(entry);
    relays.set(sessionHash, set);
    return () => {
      set.delete(entry);
      if (set.size === 0) relays.delete(sessionHash);
      if (kind === "viewer") scheduleViewerCheck(agentId);
    };
  }
  function closeSession(sessionHash: string): void {
    for (const entry of relays.get(sessionHash) ?? []) entry.close();
  }
  function viewersOpen(agentId: string): number {
    let n = 0;
    for (const set of relays.values()) for (const entry of set) if (entry.kind === "viewer" && entry.agentId === agentId) n += 1;
    return n;
  }
  // The owner lost sight of the computer during a takeover (phone asleep, tab closed): after a grace period the
  // takeover ends in "paused", never handing a half-finished login to the agent.
  const VIEWER_GRACE_MS = 30_000;
  function scheduleViewerCheck(agentId: string): void {
    const observed = computer.lease(agentId);
    void observed.catch(() => undefined);
    setTimeout(() => {
      if (viewersOpen(agentId) > 0) return;
      void slots.exclusive(agentId, async () => {
        const before = await observed;
        const slot = await slots.require(agentId);
        if (slot.removing_at) return;
        const lease = await computer.lease(agentId);
        // A timer from a previous occupant must not pause a reused slot's computer.
        if (lease.holder === "owner" && lease.generation === before.generation) await computer.setLease(agentId, "paused", "system");
      })
        .catch((error: unknown) => log.warn({ err: String(error) }, "pausing an unwatched takeover failed"));
    }, VIEWER_GRACE_MS).unref();
  }
  const relaySweep = setInterval(() => {
    for (const hash of [...relays.keys()]) {
      void auth.sessionAlive(hash).then(async (alive) => {
        if (!alive) return closeSession(hash);
        for (const entry of [...(relays.get(hash) ?? [])]) {
          if (entry.alive && !(await entry.alive())) entry.close();
        }
      }).catch(() => undefined);
    }
  }, 15_000);
  relaySweep.unref();

  function setChallengeCookie(reply: FastifyReply, id: string): void {
    void reply.setCookie(CHALLENGE_COOKIE, id, { httpOnly: true, secure: secureCookies, sameSite: "strict", path: "/api/", maxAge: 300 });
  }

  // --- Sign-in -----------------------------------------------------------------------------------------------------

  app.post("/api/setup/options", signInRoute, async (request, reply) => {
    const { ticket } = parse(SetupOptionsRequest, request.body);
    const { challengeId, options } = await auth.setupOptions(ticket);
    setChallengeCookie(reply, challengeId);
    return options;
  });
  app.post("/api/setup/verify", signInRoute, async (request, reply) => {
    const { ticket, response } = parse(SetupVerifyRequest, request.body);
    const token = await auth.setupVerify(ticket, ownerCookie(request, CHALLENGE_COOKIE) ?? "", response);
    setSessionCookie(reply, token);
    return me();
  });
  app.post("/api/auth/options", signInRoute, async (_request, reply) => {
    const { challengeId, options } = await auth.signinOptions("signin", null);
    setChallengeCookie(reply, challengeId);
    return options;
  });
  app.post("/api/auth/verify", signInRoute, async (request, reply) => {
    const { response } = parse(AuthVerifyRequest, request.body);
    const token = await auth.signinVerify("signin", ownerCookie(request, CHALLENGE_COOKIE) ?? "", response, null);
    if (token) setSessionCookie(reply, token);
    return me();
  });
  app.post("/api/auth/fresh/options", signInRoute, async (request, reply) => {
    const session = await requireSession(request);
    const { challengeId, options } = await auth.signinOptions("fresh", session.hash);
    setChallengeCookie(reply, challengeId);
    return options;
  });
  app.post("/api/auth/fresh/verify", signInRoute, async (request) => {
    const session = await requireSession(request);
    const { response } = parse(AuthVerifyRequest, request.body);
    await auth.signinVerify("fresh", ownerCookie(request, CHALLENGE_COOKIE) ?? "", response, session.hash);
    const refreshed = await requireSession(request);
    return { freshUntil: refreshed.freshUntil?.toISOString() ?? null };
  });
  app.post("/api/auth/logout", appRoute, async (request, reply) => {
    const session = await requireSession(request);
    await auth.signOut(session.hash);
    closeSession(session.hash);
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    void reply.clearCookie(KILL_COOKIE, { path: "/api/agents/" });
    return {};
  });

  async function me(session?: SessionInfo | null): Promise<unknown> {
    return {
      ownerName: config.ownerName,
      passkeys: await auth.passkeyCount(),
      freshUntil: session?.freshUntil?.toISOString() ?? null,
    };
  }
  app.get("/api/me", appRoute, async (request) => me(await requireSession(request)));

  // --- Desktop app ---------------------------------------------------------------------------------------------------

  app.get("/api/desktop/info", appRoute, async () => ({
    product: "quokkabot" as const,
    apiVersion: 1 as const,
    appOrigin: config.appOrigin,
    viewOrigin: config.viewOrigin,
    desktopDownloads: config.desktopRoot !== undefined,
    minDesktopVersion: MIN_DESKTOP_VERSION,
    phoneApi: 1 as const,
  }));
  app.post("/api/desktop-link/start", signInRoute, async (request) => {
    const body = parse(DesktopLinkStartRequest, request.body);
    const requester = body.kind === "fresh" ? await requireSession(request) : null;
    // The re-check through the browser is for the Mac app. A phone session never becomes fresh.
    if (requester?.client === "phone") throw new HttpError(403, "phone_not_fresh", "Confirm this in the web app or the Mac app.");
    return desktopLinks.start(body.kind, body.deviceName, requester?.hash ?? null);
  });
  app.get<{ Querystring: { code?: string } }>("/api/desktop-link/pending", appRoute, async (request) => {
    await requireSession(request);
    const { userCode } = parse(DesktopLinkDecideRequest, { userCode: (request.query.code ?? "").toUpperCase() });
    return desktopLinks.pending(userCode);
  });
  // Approving a desktop link takes a passkey assertion made for that link, in the browser, right now.
  app.post("/api/desktop-link/approve/options", signInRoute, async (request, reply) => {
    const session = await requireSession(request);
    const { userCode } = parse(DesktopLinkDecideRequest, request.body);
    const linkId = await desktopLinks.linkId(userCode);
    const { challengeId, options } = await auth.signinOptions("link", session.hash, linkId);
    setChallengeCookie(reply, challengeId);
    return options;
  });
  app.post("/api/desktop-link/approve/verify", signInRoute, async (request) => {
    const session = await requireSession(request);
    const { userCode, response } = parse(DesktopLinkApproveVerifyRequest, request.body);
    const linkId = await desktopLinks.linkId(userCode);
    await auth.signinVerify("link", ownerCookie(request, CHALLENGE_COOKIE) ?? "", response, session.hash, linkId);
    await desktopLinks.approve(userCode, linkId);
    return {};
  });
  app.post("/api/desktop-link/refuse", signInRoute, async (request) => {
    await requireSession(request);
    const { userCode } = parse(DesktopLinkDecideRequest, request.body);
    await desktopLinks.refuse(userCode);
    return {};
  });
  app.post("/api/desktop-link/poll", appRoute, async (request, reply) => {
    const { pollToken } = parse(DesktopLinkPollRequest, request.body);
    const outcome = await desktopLinks.poll(pollToken, "desktop");
    if (outcome.state === "approved" && outcome.kind === "signin") setSessionCookie(reply, outcome.sessionToken);
    if (outcome.state === "pending") void reply.status(202);
    if (outcome.state === "refused" || outcome.state === "expired") void reply.status(410);
    return { state: outcome.state };
  });

  // --- Phone app ----------------------------------------------------------------------------------------------------
  // Three ways to sign the iPhone app in, each ending in a phone session whose token goes to the phone once, in the
  // body (PhoneSessionResponse). The routes need no Origin, read no cookies and are never cached.

  const phoneSignInRoute = { ...appRoute, config: { rateLimit: { max: 30, timeWindow: "1 minute" }, phoneSignIn: true } };
  // The phone polls a link every two seconds, so the poll keeps the general allowance, like the desktop poll.
  const phonePollRoute = { ...appRoute, config: { phoneSignIn: true } };
  const noStore = (reply: FastifyReply): void => { void reply.header("cache-control", "no-store"); };

  // A passkey: only builds that carry this domain in their entitlements (and in QB's appleAppIds) can make one.
  app.post("/api/phone/passkey/options", phoneSignInRoute, async (_request, reply) => {
    noStore(reply);
    return auth.signinOptions("phone", null);
  });
  app.post("/api/phone/passkey/verify", phoneSignInRoute, async (request, reply) => {
    const { challengeId, response, deviceName } = parse(PhonePasskeyVerifyRequest, request.body);
    noStore(reply);
    const token = await auth.signinVerify("phone", challengeId, response, null, null, deviceName);
    if (!token) throw new HttpError(500, "internal", "No session was created.");
    return { token };
  });
  // A link the owner approves in a browser where they are signed in, on this phone or another device.
  app.post("/api/phone/link/start", phoneSignInRoute, async (request, reply) => {
    const { deviceName } = parse(PhoneLinkStartRequest, request.body);
    noStore(reply);
    return desktopLinks.start("signin", deviceName, null, "phone");
  });
  app.post("/api/phone/link/poll", phonePollRoute, async (request, reply) => {
    const { pollToken } = parse(DesktopLinkPollRequest, request.body);
    noStore(reply);
    const outcome = await desktopLinks.poll(pollToken, "phone");
    if (outcome.state === "approved" && outcome.kind === "signin") return { state: "approved", token: outcome.sessionToken };
    void reply.status(outcome.state === "pending" ? 202 : 410);
    return { state: outcome.state === "approved" ? "expired" : outcome.state };
  });
  // A code printed by the server's operator (`pairing-code`).
  app.post("/api/phone/code", phoneSignInRoute, async (request, reply) => {
    const { code, deviceName } = parse(PhoneCodeRequest, request.body);
    noStore(reply);
    return { token: await pairingCodes.redeem(code, deviceName) };
  });

  // Lets the iPhone builds named in appleAppIds use native passkeys on this domain. Without the setting there is no
  // file: no build may.
  app.get("/.well-known/apple-app-site-association", appRoute, async (_request, reply) => {
    if (config.appleAppIds.length === 0) throw new HttpError(404, "not_found", "No such file.");
    return reply.type("application/json").header("cache-control", "public, max-age=3600").send({ webcredentials: { apps: config.appleAppIds } });
  });

  // --- Signed-in devices and activity -----------------------------------------------------------------------------

  app.get("/api/sessions", appRoute, async (request) => {
    const session = await requireSession(request);
    return { sessions: await auth.devices(session.hash) };
  });
  app.delete<{ Params: { id: string } }>("/api/sessions/:id", appRoute, async (request) => {
    await requireSession(request);
    const hash = await auth.revokeDevice(request.params.id);
    if (!hash) throw new HttpError(404, "unknown_session", "No such device.");
    closeSession(hash);
    return {};
  });
  // Finished tasks after a cursor ("<iso time>|<task id>"), oldest first, 50 per page. Without a cursor the answer is
  // the current position, so a new client starts from now instead of replaying history.
  app.get<{ Querystring: { cursor?: string } }>("/api/activity", appRoute, async (request) => {
    await requireSession(request);
    const ids = await slots.ids();
    const raw = request.query.cursor;
    if (!raw) {
      const head = await maybeOne<{ at: string; id: string }>(
        db,
        `select ${CURSOR_AT} as at, id from tasks where state in ('completed','failed','outcome_unknown','cancelled')
         and agent_id = any($1::uuid[]) order by updated_at desc, id desc limit 1`,
        [ids],
      );
      const cursor = head ? `${head.at}|${head.id}` : `${new Date(0).toISOString()}|00000000-0000-0000-0000-000000000000`;
      return { items: [], cursor, more: false };
    }
    const [at, id] = raw.split("|");
    if (!at || !id || Number.isNaN(Date.parse(at)) || !UUID_RE.test(id)) throw new HttpError(400, "invalid_cursor", "Invalid cursor.");
    const rows = await many<{ id: string; agent_id: string; title: string; state: string; updated_at: Date; at: string }>(
      db,
      `select id, agent_id, title, state, updated_at, ${CURSOR_AT} as at from tasks
       where state in ('completed','failed','outcome_unknown','cancelled') and (updated_at, id) > ($1::timestamptz, $2::uuid)
         and not exists (select 1 from runs r where r.task_id = tasks.id and r.diagnostic)
         and agent_id = any($3::uuid[])
       order by updated_at, id limit 51`,
      [at, id, ids],
    );
    const page = rows.slice(0, 50);
    const last = page.at(-1);
    return {
      items: page.map((r) => ({ taskId: r.id, agentId: r.agent_id, title: r.title, state: r.state, at: r.updated_at.toISOString() })),
      cursor: last ? `${last.at}|${last.id}` : raw,
      more: rows.length > 50,
    };
  });

  // Every agent's kill switch at once (desktop menu, tray and shortcut). Like the single kill route it accepts the signed
  // kill capability without the database, and it reports per agent whether network and sandboxes were stopped.
  app.post("/api/agents/kill-all", appRoute, async (request) => {
    if (!killCapabilityValid(config.secrets.sessionSecret, ownerCookie(request, KILL_COOKIE))) await requireSession(request);
    const agents = await Promise.all(
      [...slots.knownIds].map(async (agentId) => {
        const { errors } = await computer.kill(agentId);
        return {
          agentId,
          egressFrozen: !errors.some((e) => e.startsWith("egress")),
          sandboxesStopped: !errors.some((e) => e.startsWith("supervisor")),
          error: errors.length > 0 ? errors.join("; ").slice(0, 400) : null,
        };
      }),
    );
    if (agents.some((a) => a.error)) log.error({ agents }, "kill-all had errors");
    return { confirmed: agents.every((a) => a.egressFrozen && a.sandboxesStopped), agents };
  });

  // The desktop app's builds and update manifests, when this server publishes them. Public: the app is open source and
  // the files are signed.
  app.get<{ Params: { file: string } }>("/desktop/:file", appRoute, async (request, reply) => {
    const root = config.desktopRoot;
    const file = request.params.file;
    if (!root || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(file)) throw new HttpError(404, "not_found", "No such file.");
    const path = join(root, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, "not_found", "No such file.");
    const ext = file.split(".").at(-1) ?? "";
    const types: Record<string, string> = { yml: "text/yaml", dmg: "application/x-apple-diskimage", zip: "application/zip", blockmap: "application/octet-stream", exe: "application/octet-stream", AppImage: "application/octet-stream" };
    void reply.headers({
      "content-type": types[ext] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": ext === "yml" ? "no-cache" : "public, max-age=3600",
      ...(ext === "yml" ? {} : { "content-disposition": `attachment; filename="${file}"` }),
    });
    return reply.send(createReadStream(path));
  });

  // Claude Code's login runs entirely in the CLI sandbox. Only the provider URL, one-time code and status cross it.
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/claude-sign-in", appRoute, async (request) => {
    await requireSession(request);
    return claudeSignIns.start(await agentParam(request.params.agentId));
  });
  app.post<{ Params: { signInId: string } }>("/api/claude-sign-in/:signInId/code", appRoute, async (request) => {
    await requireSession(request);
    return claudeSignIns.submit(uuidParam(request.params.signInId, "sign_in"), request.body);
  });
  app.delete<{ Params: { signInId: string } }>("/api/claude-sign-in/:signInId", appRoute, async (request) => {
    await requireSession(request);
    await claudeSignIns.cancel(uuidParam(request.params.signInId, "sign_in"));
    return {};
  });

  // --- Agents and computer -------------------------------------------------------------------------------------------

  async function agentSummary(agentId: string): Promise<AgentSummary> {
    await slots.require(agentId);
    const row = await one<{ id: string; idx: number; generation: number; removing_at: Date | null; name: string; model: string; effort: string; cli_signed_in: "yes" | "no" | "unknown"; cli_account: string | null; cli_plan: string | null }>(
      db,
      "select id, idx, generation, removing_at, name, model, effort, cli_signed_in, cli_account, cli_plan from agents where id = $1 and added_at is not null",
      [agentId],
    );
    const active = await maybeOne<{ id: string }>(db, "select id from tasks where agent_id = $1 and state = 'running' and not exists (select 1 from runs r where r.task_id = tasks.id and r.diagnostic) order by updated_at desc limit 1", [agentId]);
    const waiting = await one<{ n: number }>(
      db,
      `select (select count(*) from owner_requests o join tasks t on t.id = o.task_id where t.agent_id = $1 and o.answered_at is null)
            + (select count(*) from domain_requests where agent_id = $1 and decided_at is null) as n`,
      [agentId],
    );
    return {
      id: row.id as AgentSummary["id"],
      generation: row.generation,
      index: row.idx,
      removing: row.removing_at !== null,
      name: row.name,
      model: row.model,
      effort: row.effort as AgentSummary["effort"],
      cliSignedIn: row.cli_signed_in,
      cliAccount: row.cli_account,
      cliPlan: row.cli_plan,
      computer: await computer.view(agentId),
      activeTaskId: (active?.id ?? null) as AgentSummary["activeTaskId"],
      waitingOnOwner: Number(waiting.n),
    };
  }

  app.get("/api/agents", appRoute, async (request) => {
    await requireSession(request);
    const ids = await slots.ids();
    return { agents: await Promise.all(ids.map(agentSummary)), capacity: { used: ids.length, total: config.agents.length } };
  });
  app.post("/api/agents", appRoute, async (request, reply) => {
    await requireSession(request);
    const { name } = parse(CreateAgentRequest, request.body);
    const id = await slots.create(name);
    void reply.status(201);
    return agentSummary(id);
  });
  app.delete<{ Params: { agentId: string } }>("/api/agents/:agentId", appRoute, async (request) => {
    await requireSession(request);
    const id = uuidParam(request.params.agentId, "agent");
    const generation = request.headers["x-quokkabot-agent-generation"];
    await slots.remove(id, { tasks, computer, supervisor, connectors, policy, drainTools: deps.drainTools, closeRelays: () => {
      for (const set of relays.values()) for (const entry of set) if (entry.agentId === id) entry.close();
    }, dropSignIns: (agentId) => { claudeSignIns.dropAgent(agentId); } }, Array.isArray(generation) ? generation.join(",") : generation);
    return {};
  });
  app.get<{ Params: { agentId: string } }>("/api/agents/:agentId", appRoute, async (request) => {
    await requireSession(request);
    return agentSummary(await agentParam(request.params.agentId));
  });
  app.put<{ Params: { agentId: string } }>("/api/agents/:agentId/settings", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const body = parse(AgentSettingsRequest, request.body);
    await db.query("update agents set model = $2, effort = $3, name = coalesce($4, name) where id = $1", [agentId, body.model, body.effort, body.name ?? null]);
    await audit.append(agentId, "owner", "agent.settings_changed", { ...body });
    return agentSummary(agentId);
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/computer/start", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    await computer.start(agentId);
    return computer.view(agentId);
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/computer/stop", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    await computer.stop(agentId);
    return computer.view(agentId);
  });
  // The kill switch accepts the signed kill capability without touching the database, so it works while PostgreSQL is
  // down; the Origin check above still applies.
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/kill", appRoute, async (request, reply) => {
    const agentId = uuidParam(request.params.agentId, "agent");
    if (!slots.knownIds.has(agentId)) throw new HttpError(404, "unknown_agent", "No such agent.");
    if (!killCapabilityValid(config.secrets.sessionSecret, ownerCookie(request, KILL_COOKIE))) await requireSession(request);
    const { errors } = await computer.kill(agentId);
    if (errors.length > 0) {
      log.error({ errors }, "kill switch had errors");
      void reply.status(500);
      return { error: { code: "kill_partial", message: `Stopped with errors: ${errors.join("; ").slice(0, 400)}` } };
    }
    return computer.view(agentId);
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/kill/release", appRoute, async (request) => {
    const session = await requireSession(request);
    if (!isFresh(session)) throw new HttpError(403, "fresh_auth_required", "Confirm with your passkey first.");
    const agentId = await agentParam(request.params.agentId);
    await computer.releaseKill(agentId);
    return computer.view(agentId);
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/takeover", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const { action } = parse(TakeoverRequest, request.body);
    return computer.takeover(agentId, action);
  });
  const ownerFieldRoute = { ...signInRoute, onSend: async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    void reply.header("cache-control", "no-store");
    return payload;
  } };
  async function ownerLease(agentId: string) {
    const lease = await computer.lease(agentId);
    if (lease.holder !== "owner" || (lease.expiresAt !== null && Date.parse(lease.expiresAt) <= Date.now())) {
      throw new HttpError(409, "no_takeover", "Take over the computer first.");
    }
    return lease;
  }
  app.get<{ Params: { agentId: string } }>("/api/agents/:agentId/takeover/focus", ownerFieldRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const lease = await ownerLease(agentId);
    try { return await handles(agentId).browser.ownerFocus(lease.generation); }
    catch (error) {
      if (error instanceof UpstreamError && error.status === 409) throw new HttpError(409, "no_takeover", "Take over the computer first.");
      throw new HttpError(502, "owner_focus_failed", "Could not check the field. Try again.");
    }
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/takeover/fill", ownerFieldRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const lease = await ownerLease(agentId);
    const body = parse(TakeoverFillRequest, request.body);
    let result;
    try { result = await handles(agentId).browser.ownerFill({ ...body, commandId: randomUUID(), leaseGeneration: lease.generation }); }
    catch { throw new HttpError(502, "owner_fill_failed", "Could not fill the field. Check the computer before trying again."); }
    if (result.status !== "ok") {
      if (result.status === "blocked" && result.message === "wrong field kind") throw new HttpError(409, "wrong_field", "Tap the password or code field on the computer first.");
      if (result.status === "blocked" && result.message === "wrong site") throw new HttpError(409, "wrong_site", "The page changed. Check the site and try again.");
      if (result.status === "blocked" && result.message === "no takeover") throw new HttpError(409, "no_takeover", "Take over the computer first.");
      throw new HttpError(502, "owner_fill_failed", "Could not fill the field. Check the computer before trying again.");
    }
    await audit.append(agentId, "owner", "owner.filled_field", { kind: body.kind, site: new URL(result.url!).hostname });
    return { ok: true };
  });
  // The phone fits the computer's screen to its live view while the owner has control. The browser service checks the
  // lease again and puts the desktop size back when control leaves the owner.
  app.put<{ Params: { agentId: string } }>("/api/agents/:agentId/takeover/screen", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const lease = await ownerLease(agentId);
    const body = parse(TakeoverScreenRequest, request.body);
    let size;
    try { size = await handles(agentId).browser.setScreen({ ...body, leaseGeneration: lease.generation }); }
    catch (error) {
      // The browser service answers 409 for any failure; only "no takeover" means the lease was refused.
      let refused = false;
      if (error instanceof UpstreamError && error.status === 409) {
        try { refused = JSON.parse(error.body).message === "no takeover"; } catch { /* An invalid reply is a failure. */ }
      }
      if (refused) throw new HttpError(409, "no_takeover", "Take over the computer first.");
      throw new HttpError(502, "screen_failed", "Could not fit the screen to this phone. Refresh the view.");
    }
    await audit.append(agentId, "owner", "takeover.screen", { width: size.width, height: size.height, generation: lease.generation });
    return size;
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/attended", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const { open } = parse(AttendedRequest, request.body);
    await computer.setAttended(agentId, open);
    return computer.view(agentId);
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/view-ticket", appRoute, async (request) => {
    const session = await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const ticket = await auth.createViewTicket(agentId, session.hash);
    return { url: `${config.viewOrigin}/agents/${agentId}/?ticket=${ticket}` };
  });

  // Images upload immediately; sending binds their ids to a task in its message transaction.
  app.post<{ Params: { agentId: string }; Querystring: { name?: string } }>("/api/agents/:agentId/attachments", { ...appRoute, bodyLimit: MAX_IMAGE_BYTES }, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    if (!Buffer.isBuffer(request.body)) throw new HttpError(415, "image_type", "Choose a PNG, JPEG, GIF or WebP image.");
    return uploadAttachment(db, audit, agentId, request.query.name ?? "", request.headers["content-type"]?.split(";")[0]?.trim() ?? "", request.body);
  });
  app.get<{ Params: { id: string } }>("/api/attachments/:id/content", appRoute, async (request, reply) => {
    await requireSession(request);
    const attachment = await attachmentContent(db, uuidParam(request.params.id, "attachment"));
    await slots.require(attachment.agent_id);
    return reply.headers(attachmentHeaders(attachment)).send(attachment.data);
  });

  // --- Tasks --------------------------------------------------------------------------------------------------------

  app.get<{ Params: { agentId: string }; Querystring: { before?: string } }>("/api/agents/:agentId/tasks", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const before = request.query.before && !Number.isNaN(Date.parse(request.query.before)) ? request.query.before : null;
    const rows = await many<TaskRow>(
      db,
      // Operator self-tests (diagnostic runs) are not the owner's tasks.
      "select * from tasks where agent_id = $1 and ($2::timestamptz is null or created_at < $2) and not exists (select 1 from runs r where r.task_id = tasks.id and r.diagnostic) order by created_at desc limit 50",
      [agentId, before],
    );
    return { tasks: rows.map(taskView), nextBefore: rows.length === 50 ? (rows.at(-1)?.created_at.toISOString() ?? null) : null };
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/tasks", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const { prompt, attachmentIds } = parse(CreateTaskRequest, request.body);
    const key = request.headers["idempotency-key"];
    if (key !== undefined && (typeof key !== "string" || !/^[\x21-\x7e]{1,200}$/.test(key))) {
      throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1 to 200 visible ASCII characters.");
    }
    return taskView(await tasks.create(agentId, prompt, key, attachmentIds));
  });
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId", appRoute, async (request) => {
    await requireSession(request);
    const task = await tasks.get(uuidParam(request.params.taskId, "task"));
    const runs = await many<RunRow>(db, "select * from runs where task_id = $1 order by attempt", [task.id]);
    return { task: taskView(task), runs: runs.map(runView), openRequests: await tasks.openRequests(task.id), lastSeq: task.last_seq };
  });
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/reply", appRoute, async (request) => {
    await requireSession(request);
    const { text, attachmentIds } = parse(ReplyRequest, request.body);
    return taskView(await tasks.reply(uuidParam(request.params.taskId, "task"), text, attachmentIds));
  });
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/takeover-done", appRoute, async (request) => {
    await requireSession(request);
    const { note } = parse(TakeoverDoneRequest, request.body);
    return taskView(await tasks.takeoverDone(uuidParam(request.params.taskId, "task"), note));
  });
  app.post<{ Params: { requestId: string } }>("/api/owner-requests/:requestId/sign-in-myself", appRoute, async (request) => {
    await requireSession(request);
    await tasks.signInMyself(uuidParam(request.params.requestId, "request"));
    return {};
  });
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/message", appRoute, async (request) => {
    await requireSession(request);
    const { text, attachmentIds } = parse(ReplyRequest, request.body);
    return taskView(await tasks.message(uuidParam(request.params.taskId, "task"), text, attachmentIds));
  });
  app.post<{ Params: { taskId: string } }>("/api/tasks/:taskId/cancel", appRoute, async (request) => {
    await requireSession(request);
    return taskView(await tasks.cancel(uuidParam(request.params.taskId, "task")));
  });
  app.post<{ Params: { taskId: string; seq: string } }>("/api/tasks/:taskId/events/:seq/reaction", appRoute, async (request) => {
    await requireSession(request);
    const taskId = uuidParam(request.params.taskId, "task");
    const { emoji } = parse(ReactionRequest, request.body);
    const seq = Number(request.params.seq);
    if (!/^[1-9][0-9]*$/.test(request.params.seq) || !Number.isSafeInteger(seq) || seq > 2_147_483_647) {
      throw new HttpError(400, "invalid_request", "Message sequence must be a positive 32-bit integer.");
    }
    await tasks.react(taskId, { by: "owner", targetSeq: seq, emoji });
    return {};
  });

  // Server-sent events: everything after `after` (or Last-Event-ID), then live.
  app.get<{ Params: { taskId: string }; Querystring: { after?: string } }>("/api/tasks/:taskId/events", appRoute, async (request, reply) => {
    await requireSession(request);
    const taskId = uuidParam(request.params.taskId, "task");
    const task = await tasks.get(taskId);
    const lastHeader = request.headers["last-event-id"];
    let after = Number(typeof lastHeader === "string" ? lastHeader : (request.query.after ?? "0"));
    if (!Number.isFinite(after) || after < 0) after = 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    let sending = Promise.resolve();
    const send = (): void => {
      sending = sending.then(async () => {
        // Drain every stored batch, not just the first: a long finished task has more than one.
        for (;;) {
          if (closed) return;
          const batch = await events.after(taskId, after);
          for (const envelope of batch) {
            res.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
            after = envelope.seq;
          }
          if (batch.length < 500) return;
        }
      }).catch((error: unknown) => log.warn({ err: String(error) }, "sse send failed"));
    };
    const onEvent = (): void => send();
    events.emitter.on(taskId, onEvent);
    const untrack = track(request.session?.hash ?? "", task.agent_id, "stream", () => res.end());
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
    request.raw.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      events.emitter.off(taskId, onEvent);
      untrack();
    });
    send();
  });

  // --- Inbox --------------------------------------------------------------------------------------------------------

  app.get("/api/inbox", appRoute, async (request) => {
    await requireSession(request);
    const items: InboxItem[] = [];
    const addedIds = new Set(await slots.ids());
    const requests = await many<OwnerRequestRow & { agent_id: string; title: string }>(
      db,
      "select o.*, t.agent_id, t.title from owner_requests o join tasks t on t.id = o.task_id where o.answered_at is null order by o.created_at",
    );
    for (const r of requests) {
      if (!addedIds.has(r.agent_id)) continue;
      items.push({ kind: "owner_request", agentId: r.agent_id as InboxItem["agentId"], taskTitle: r.title, request: ownerRequestView(r) });
    }
    const domains = await many<{ id: string; agent_id: string; task_id: string | null; domains: string[]; reason: string; created_at: Date; title: string | null }>(
      db,
      "select d.*, t.title from domain_requests d left join tasks t on t.id = d.task_id where d.decided_at is null order by d.created_at",
    );
    for (const d of domains) {
      if (!addedIds.has(d.agent_id)) continue;
      items.push({
        kind: "domain_request",
        agentId: d.agent_id as InboxItem["agentId"],
        taskTitle: d.title,
        request: {
          id: d.id as never,
          taskId: d.task_id as never,
          domains: d.domains,
          reason: d.reason,
          createdAt: d.created_at.toISOString(),
          decidedAt: null,
          decision: null,
        },
      });
    }
    return { items };
  });

  // --- Files --------------------------------------------------------------------------------------------------------

  app.get<{ Params: { agentId: string }; Querystring: { scope?: string; dir?: string; cursor?: string } }>(
    "/api/agents/:agentId/files",
    appRoute,
    async (request): Promise<FileListing> => {
      await requireSession(request);
      const agentId = await agentParam(request.params.agentId);
      const scope = request.query.scope === "workspace" ? "workspace" : "downloads";
      const dir = parse(RelPath, request.query.dir ?? "");
      const result = await supervisor.files(agentId, {
        op: "list",
        scope,
        dir,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      });
      if (result.op === "error") throw new HttpError(404, result.code, result.message);
      if (result.op !== "list") throw new Error("unexpected helper result");
      const published = new Map<string, Record<string, unknown>>();
      if (scope === "downloads") {
        const rows = await many<{ id: string; name: string; rel_path: string; bytes: number; sha256: string; mime_type: string; source_url: string | null; task_id: string | null; created_at: Date }>(
          db,
          "select * from files where agent_id = $1 and scope = 'downloads'",
          [agentId],
        );
        for (const r of rows) {
          published.set(r.rel_path, {
            fileId: r.id,
            name: r.name,
            bytes: r.bytes,
            sha256: r.sha256,
            mimeType: r.mime_type,
            sourceUrl: r.source_url,
            taskId: r.task_id,
            createdAt: r.created_at.toISOString(),
          });
        }
      }
      return {
        scope,
        dir,
        entries: result.entries.map((e) => ({ ...e, file: (published.get(e.path) ?? null) as never })),
        nextCursor: result.nextCursor,
      };
    },
  );

  app.get<{ Params: { fileId: string } }>("/api/files/:fileId/content", appRoute, async (request, reply) => {
    await requireSession(request);
    const fileId = uuidParam(request.params.fileId, "file");
    const file = await maybeOne<{ agent_id: string; scope: string; name: string; rel_path: string; mime_type: string; bytes: number; evidence: boolean }>(
      db,
      "select agent_id, scope, name, rel_path, mime_type, bytes, evidence from files where id = $1",
      [fileId],
    );
    if (!file) throw new HttpError(404, "unknown_file", "No such file.");
    await slots.require(file.agent_id);
    const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`;
    // Published downloads and evidence copies are written only by this process; workspace paths are not served by id.
    if (file.scope === "downloads" || file.evidence) {
      const agent = config.agents.find((a) => a.agentId === file.agent_id);
      if (!agent) throw new HttpError(404, "unknown_agent", "No such agent.");
      // Only this process writes the downloads directory, so the published path is trusted.
      const path = normalize(join(agent.downloadsDir, file.rel_path));
      if (!path.startsWith(`${agent.downloadsDir}/`)) throw new HttpError(404, "unknown_file", "No such file.");
      const info = await stat(path);
      void reply.headers({ "content-type": file.mime_type, "content-length": info.size, "content-disposition": disposition, "cache-control": "no-store" });
      return reply.send(createReadStream(path));
    }
    const res = await supervisor.exportFile(file.agent_id, { scope: "workspace", path: file.rel_path });
    void reply.headers({ "content-type": "application/octet-stream", "content-disposition": disposition, "cache-control": "no-store" });
    return reply.send(res.stream);
  });

  app.get<{ Params: { agentId: string }; Querystring: { path?: string } }>("/api/agents/:agentId/workspace-file", appRoute, async (request, reply) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const path = parse(RelPath, request.query.path ?? "");
    const res = await supervisor.exportFile(agentId, { scope: "workspace", path });
    const name = path.split("/").at(-1) ?? "file";
    void reply.headers({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
    });
    return reply.send(res.stream);
  });

  // --- Logins (the vault) --------------------------------------------------------------------------------------------

  app.get<{ Params: { agentId: string } }>("/api/agents/:agentId/logins", appRoute, async (request) => {
    await requireSession(request);
    return { logins: await vault.list(await agentParam(request.params.agentId)) };
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/logins", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const body = parse(SaveLoginRequest, request.body);
    const saved = await vault.save(agentId, body);
    await tasks.loginSaved(agentId, saved);
    return saved;
  });
  app.put<{ Params: { loginId: string } }>("/api/logins/:loginId", appRoute, async (request) => {
    await requireSession(request);
    const body = parse(UpdateLoginRequest, request.body);
    const updated = await vault.update(uuidParam(request.params.loginId, "login"), body);
    await tasks.loginSaved(updated.agentId, updated);
    return updated;
  });
  app.delete<{ Params: { loginId: string } }>("/api/logins/:loginId", appRoute, async (request) => {
    await requireSession(request);
    await vault.remove(uuidParam(request.params.loginId, "login"));
    return {};
  });

  // --- Connected apps -------------------------------------------------------------------------------------------------

  app.get<{ Params: { agentId: string } }>("/api/agents/:agentId/connectors", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    return { connectors: await connectors.list(agentId), available: connectors.available() };
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/connectors/gmail/start", appRoute, async (request) => {
    await requireSession(request);
    return { url: await connectors.start(await agentParam(request.params.agentId)) };
  });
  app.delete<{ Params: { connectorId: string } }>("/api/connectors/:connectorId", appRoute, async (request) => {
    await requireSession(request);
    await connectors.remove(uuidParam(request.params.connectorId, "connector"));
    return {};
  });
  // Google sends the owner's browser here after the consent page. No session: the single-use state proves the start.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/connect/google/callback", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const page = (ok: boolean, account: string | null, message: string) => reply.type("text/html; charset=utf-8").send(connectedPage(ok, account, message, config.appOrigin));
    if (request.query.error) return page(false, null, `Google said: ${request.query.error}. You can try again from Quokka Bot.`);
    if (!request.query.code || !request.query.state) return page(false, null, "The link is incomplete. Start again in Quokka Bot.");
    try {
      const connected = await connectors.callback(request.query.code, request.query.state,
        (account) => tasks.connectorConnected(account.agentId, "gmail", account.account));
      return page(true, connected.account, "");
    } catch (error) {
      return page(false, null, error instanceof Error ? error.message : String(error));
    }
  });
  // Public pages that Google's consent screen links to.
  app.get("/about", async (_request, reply) => reply.type("text/html; charset=utf-8").send(aboutPage(config.appOrigin, config.publicContact ?? null)));
  app.get("/privacy", async (_request, reply) => reply.type("text/html; charset=utf-8").send(privacyPage(config.appOrigin, config.publicContact ?? null)));

  // --- Domains -------------------------------------------------------------------------------------------------------

  async function domainsView(agentId: string): Promise<DomainsView> {
    const rules = await many<{ id: string; pattern: string; attended: boolean; task_id: string | null; created_at: Date }>(
      db,
      "select id, pattern, attended, task_id, created_at from domain_rules where agent_id = $1 and (expires_at is null or expires_at > now()) order by pattern",
      [agentId],
    );
    const pending = await many<{ id: string; task_id: string | null; domains: string[]; reason: string; created_at: Date }>(
      db,
      "select id, task_id, domains, reason, created_at from domain_requests where agent_id = $1 and decided_at is null order by created_at",
      [agentId],
    );
    const blocked = await many<{ host: string; decision: string; count: number; last_at: Date; task_id: string | null }>(
      db,
      "select host, decision, count, last_at, task_id from blocked_hosts where agent_id = $1 and last_at > now() - interval '7 days' order by last_at desc limit 100",
      [agentId],
    );
    return {
      rules: rules.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        attended: r.attended,
        scope: r.task_id ? "task" : "permanent",
        taskId: r.task_id as never,
        createdAt: r.created_at.toISOString(),
      })),
      pending: pending.map((p) => ({
        id: p.id as never,
        taskId: p.task_id as never,
        domains: p.domains,
        reason: p.reason,
        createdAt: p.created_at.toISOString(),
        decidedAt: null,
        decision: null,
      })),
      blocked: blocked.map((b) => ({ host: b.host, decision: b.decision as never, count: b.count, lastAt: b.last_at.toISOString(), taskId: b.task_id as never })),
    };
  }

  app.get<{ Params: { agentId: string } }>("/api/agents/:agentId/domains", appRoute, async (request) => {
    await requireSession(request);
    return domainsView(await agentParam(request.params.agentId));
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/domains", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const body = parse(AddDomainRuleRequest, request.body);
    const row = await one<{ id: string; created_at: Date }>(
      db,
      "insert into domain_rules (id, agent_id, pattern, attended, created_by) values (gen_random_uuid(), $1, $2, $3, 'owner') returning id, created_at",
      [agentId, body.pattern, body.attended],
    );
    await audit.append(agentId, "owner", "domain.rule_added", { pattern: body.pattern, attended: body.attended, scope: "permanent" });
    await policy.push();
    return { id: row.id, pattern: body.pattern, attended: body.attended, scope: "permanent", taskId: null, createdAt: row.created_at.toISOString() };
  });
  app.delete<{ Params: { ruleId: string } }>("/api/domain-rules/:ruleId", appRoute, async (request) => {
    await requireSession(request);
    const ruleId = uuidParam(request.params.ruleId, "rule");
    const row = await maybeOne<{ agent_id: string; pattern: string }>(db, "delete from domain_rules where id = $1 returning agent_id, pattern", [ruleId]);
    if (!row) throw new HttpError(404, "unknown_rule", "No such rule.");
    await audit.append(row.agent_id, "owner", "domain.rule_removed", { pattern: row.pattern });
    await policy.push();
    return {};
  });
  app.post<{ Params: { requestId: string } }>("/api/domain-requests/:requestId/decide", appRoute, async (request) => {
    await requireSession(request);
    const requestId = uuidParam(request.params.requestId, "request");
    const body = parse(DecideDomainRequest, request.body);
    const row = await maybeOne<{ agent_id: string; task_id: string | null; domains: string[] }>(
      db,
      "update domain_requests set decided_at = now(), decision = $2, attended = $3 where id = $1 and decided_at is null returning agent_id, task_id, domains",
      [requestId, body.decision, body.attended],
    );
    if (!row) throw new HttpError(409, "already_decided", "This request was already decided.");
    if (body.decision !== "refuse") {
      for (const pattern of row.domains) {
        await db.query(
          "insert into domain_rules (id, agent_id, pattern, attended, task_id, created_by) values (gen_random_uuid(), $1, $2, $3, $4, 'owner')",
          [row.agent_id, pattern, body.attended, body.decision === "allow_task" ? row.task_id : null],
        );
      }
      await policy.push();
    }
    await audit.append(row.agent_id, "owner", "domain.decided", { requestId, decision: body.decision, attended: body.attended, domains: row.domains });
    if (row.task_id) await events.append(db, row.task_id, { kind: "domain_decided", requestId: requestId as DomainRequestId, decision: body.decision, attended: body.attended });
    await tasks.domainDecided(
      row.task_id,
      body.decision === "refuse"
        ? `The owner refused access to ${row.domains.map(siteLabel).join(", ")}.`
        : `The owner allowed ${row.domains.map(siteLabel).join(", ")}${body.attended ? " (only while they attend)" : ""}. Continue.`,
    );
    return domainsView(row.agent_id);
  });

  // --- Audit --------------------------------------------------------------------------------------------------------

  app.get<{ Params: { agentId: string }; Querystring: { before?: string } }>("/api/agents/:agentId/audit", appRoute, async (request) => {
    await requireSession(request);
    const agentId = await agentParam(request.params.agentId);
    const before = request.query.before ? Number(request.query.before) : null;
    return { events: await audit.page(agentId, before !== null && Number.isFinite(before) ? before : null), head: await audit.head(agentId) };
  });
  app.get<{ Params: { agentId: string } }>("/api/agents/:agentId/audit/verify", appRoute, async (request) => {
    await requireSession(request);
    const result = await audit.verify(await agentParam(request.params.agentId));
    return result.ok ? { ok: true, count: result.count, head: result.head } : result;
  });

  // --- Viewer origin --------------------------------------------------------------------------------------------------

  app.get<{ Params: { agentId: string }; Querystring: { ticket?: string } }>("/agents/:agentId/", viewRoute, async (request, reply) => {
    const agentId = await agentParam(request.params.agentId);
    if (request.query.ticket) {
      const token = await auth.redeemViewTicket(request.query.ticket, agentId);
      void reply.setCookie(VIEW_COOKIE, token, { httpOnly: true, secure: secureCookies, sameSite: "strict", path: `/agents/${agentId}/`, maxAge: 12 * 3600 });
      return reply.redirect(`/agents/${agentId}/`, 303);
    }
    return proxyViewer(request, reply, agentId, "");
  });
  app.get<{ Params: { agentId: string; "*": string } }>("/agents/:agentId/*", viewRoute, async (request, reply) => {
    const agentId = await agentParam(request.params.agentId);
    return proxyViewer(request, reply, agentId, request.params["*"]);
  });

  // Selkies' static client only. Its API (tokens, files, uploads, recording, screenshots) is never reachable from
  // the viewer origin; the WebSocket is handled in the upgrade handler below.
  async function proxyViewer(request: FastifyRequest, reply: FastifyReply, agentId: string, rest: string): Promise<FastifyReply> {
    if ((await auth.viewSession(request.cookies[VIEW_COOKIE], agentId)) === null) {
      return reply.status(403).type("text/plain").send("Open the computer from the Quokka Bot app.");
    }
    if (rest.startsWith("api") || rest.includes("..") || rest.includes("\\")) return reply.status(404).send();
    const upstream = handles(agentId).selkies.upstream;
    const queryIndex = request.url.indexOf("?");
    const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({ ...upstream, method: "GET", path: `/${rest}${query}`, headers: { accept: request.headers.accept ?? "*/*" } }, resolve);
      req.setTimeout(15_000, () => req.destroy(new Error("viewer upstream timeout")));
      req.on("error", reject);
      req.end();
    });
    const headers: Record<string, string> = {
      "content-security-policy": `frame-ancestors ${config.appOrigin}`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    };
    const type = res.headers["content-type"];
    if (typeof type === "string") headers["content-type"] = type;
    void reply.status(res.statusCode ?? 502).headers(headers);
    return reply.send(res);
  }

  // --- Static owner app ---------------------------------------------------------------------------------------------

  app.get<{ Params: { "*": string } }>("/*", appRoute, async (request, reply) => {
    const rest = request.params["*"];
    if (rest.startsWith("api/")) throw new HttpError(404, "not_found", "No such endpoint.");
    const candidate = normalize(join(deps.webRoot, rest));
    if (rest !== "" && candidate.startsWith(`${deps.webRoot}/`)) {
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) {
        const ext = candidate.split(".").at(-1) ?? "";
        const types: Record<string, string> = { js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", json: "application/json", webmanifest: "application/manifest+json", woff2: "font/woff2" };
        void reply.headers({ "content-type": types[ext] ?? "application/octet-stream", "cache-control": rest.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
        return reply.send(createReadStream(candidate));
      }
    }
    const html = await readFile(join(deps.webRoot, "index.html"));
    void reply.headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return reply.send(html);
  });

  // --- WebSocket upgrades: terminal (app origin) and live view (viewer origin) -------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const server = app.server;
  server.on("upgrade", (req, socket, head) => {
    void handleUpgrade(req, socket, head).catch((error: unknown) => {
      log.warn({ err: String(error) }, "upgrade refused");
      refuse(socket, error instanceof HttpError ? error.status : 500);
    });
  });

  async function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const host = req.headers.host ?? "";
    const url = new URL(req.url ?? "/", "http://x");
    const cookies = parseCookies(req.headers.cookie ?? "");
    if (host === config.appHost) {
      const match = /^\/api\/agents\/([0-9a-f-]{36})\/terminal$/.exec(url.pathname);
      // The terminal is for the web and Mac apps: their session cookie, never a phone's bearer token.
      if (!match?.[1] || req.headers.origin !== config.appOrigin || hasAuthorization(req)) throw new HttpError(403, "refused", "refused");
      const agentId = await agentParam(match[1]);
      const release = await slots.acquire(agentId);
      try {
        await slots.require(agentId, false);
        const session = await auth.session(cookies[SESSION_COOKIE], "cookie");
        if (!session) throw new HttpError(401, "signed_out", "signed out");
        if (!isFresh(session)) throw new HttpError(403, "fresh_auth_required", "fresh auth required");
        const running = await maybeOne(db, "select 1 from runs where agent_id = $1 and state in ('starting','running') limit 1", [agentId]);
        if (running) throw new HttpError(409, "task_running", "task running");
        wss.handleUpgrade(req, socket, head, (client) => {
          const untrack = track(session.hash, agentId, "terminal", () => client.close(4001, "signed out"));
          client.on("close", untrack);
          relayTerminal(client, agentId);
        });
      } finally { release(); }
      return;
    }
    if (host === config.viewHost) {
      const match = /^\/agents\/([0-9a-f-]{36})\/api\/websockets$/.exec(url.pathname);
      if (!match?.[1] || req.headers.origin !== config.viewOrigin) throw new HttpError(403, "refused", "refused");
      const agentId = await agentParam(match[1]);
      await slots.require(agentId, false);
      const viewToken = cookies[VIEW_COOKIE];
      const sessionHash = await auth.viewSession(viewToken, agentId);
      if (sessionHash === null || viewToken === undefined) throw new HttpError(403, "refused", "refused");
      const ownerToken = await maybeOne<{ selkies_owner_token: string | null }>(db, "select selkies_owner_token from agents where id = $1", [agentId]);
      if (!ownerToken?.selkies_owner_token) throw new HttpError(409, "not_started", "computer not started");
      const untrack = track(sessionHash, agentId, "viewer", () => socket.destroy(), () => auth.viewSessionAlive(viewToken, agentId));
      socket.once("close", untrack);
      pipeViewerSocket(req, socket, head, agentId, ownerToken.selkies_owner_token);
      return;
    }
    throw new HttpError(421, "wrong_host", "wrong host");
  }

  function relayTerminal(client: WebSocket, agentId: string): void {
    const opts = supervisor.terminalRequestOptions(agentId);
    const upstream = new WebSocket(`ws+unix://${opts.socketPath}:${opts.path}`, { headers: opts.headers });
    void audit.append(agentId, "owner", "terminal.opened", {});
    const closeBoth = (): void => {
      if (client.readyState === WebSocket.OPEN) client.close();
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    };
    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data.toString());
    });
    client.on("message", (data) => {
      const frame = TerminalClientFrame.safeParse(safeJson(data.toString()));
      if (!frame.success) return;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(frame.data));
    });
    upstream.on("close", closeBoth);
    upstream.on("error", closeBoth);
    client.on("close", () => {
      closeBoth();
      void audit.append(agentId, "owner", "terminal.closed", {});
    });
  }

  // Raw pass-through to Selkies with the owner's token added upstream; the owner's browser never sees a token.
  function pipeViewerSocket(req: http.IncomingMessage, socket: Duplex, head: Buffer, agentId: string, ownerToken: string): void {
    const upstream = handles(agentId).selkies.upstream;
    const proxyReq = http.request({
      ...upstream,
      method: "GET",
      path: `/api/websockets?token=${encodeURIComponent(ownerToken)}`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": req.headers["sec-websocket-key"] ?? "",
        "sec-websocket-version": req.headers["sec-websocket-version"] ?? "13",
        ...(req.headers["sec-websocket-protocol"] ? { "sec-websocket-protocol": req.headers["sec-websocket-protocol"] } : {}),
        ...(req.headers["sec-websocket-extensions"] ? { "sec-websocket-extensions": req.headers["sec-websocket-extensions"] } : {}),
        // Selkies accepts only the viewer origin (SELKIES_ALLOWED_ORIGINS); the owner's Origin was checked above.
        origin: config.viewOrigin,
      },
    });
    proxyReq.on("upgrade", (res, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [key, value] of Object.entries(res.headers)) {
        if (["upgrade", "connection", "sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"].includes(key) && typeof value === "string") {
          lines.push(`${key}: ${value}`);
        }
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      const end = (): void => {
        upstreamSocket.destroy();
        socket.destroy();
      };
      upstreamSocket.on("error", end);
      socket.on("error", end);
      upstreamSocket.on("close", end);
      socket.on("close", end);
    });
    proxyReq.on("response", () => refuse(socket, 502));
    proxyReq.on("error", () => refuse(socket, 502));
    proxyReq.end();
  }

  return { app, server };
}

function refuse(socket: Duplex, status: number): void {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
  }
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
