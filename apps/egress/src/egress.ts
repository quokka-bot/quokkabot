import { createHash, timingSafeEqual } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { Agent, createServer, request as httpRequest } from "node:http";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import { createConnection, isIP } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { AgentId, EgressConfig, EgressPolicySnapshot } from "@quokkabot/shared";
import type { EgressDecision, EgressDecisionEvent, EgressDecisionsResponse, EgressListener, TaskId } from "@quokkabot/shared";
import { isPublicAddress } from "./address.js";
import { DecisionStore } from "./decisions.js";
import { authorizeHost } from "./policy.js";
import { hostHeaderMatches, parseTarget } from "./target.js";
import type { Target } from "./target.js";

export interface DnsResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
}
export interface ConnectTarget {
  address: string;
  family: 4 | 6;
  port: number;
}
export interface EgressOptions {
  config: EgressConfig;
  controlToken: string;
  resolver?: DnsResolver;
  // Return a socket connecting directly to address. Never resolve the hostname again.
  connector?: (target: ConnectTarget) => Socket;
  now?: () => number;
  onDecision?: (event: EgressDecisionEvent) => void;
}
interface TrackedConnection {
  listener: EgressListener;
  target: Target;
  method: string;
  taskId: TaskId | null;
  policyRevision: number;
  client: Duplex;
  upstream: Socket | null;
  forwarded: ClientRequest | null;
  cancellation: AbortController;
  expiryTimer: NodeJS.Timeout | null;
  closed: boolean;
  decided: boolean;
}

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function filteredHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const removed = new Set(HOP_HEADERS);
  for (const name of (headers.connection ?? "").split(",")) removed.add(name.trim().toLowerCase());
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!removed.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  result.connection = "close";
  return result;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  response.end(body);
}

function refuse(client: Duplex, response: ServerResponse | null, decision: EgressDecision, status: number): void {
  const body = `${decision}\n`;
  const headers = {
    "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body),
    Connection: "close", "X-Quokkabot-Decision": decision,
  };
  if (client.destroyed) return;
  if (response !== null) {
    response.shouldKeepAlive = false;
    response.writeHead(status, headers);
    response.end(body);
  } else {
    const reason = status === 405 ? "Method Not Allowed" : status === 400 ? "Bad Request" : status === 502 ? "Bad Gateway" : "Forbidden";
    client.end(`HTTP/1.1 ${status} ${reason}\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${body}`);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new Error("Expected application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error("JSON body exceeds 2 MiB");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("Invalid JSON body"); }
}

function listen(server: Server, address: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => { server.off("listening", ready); reject(error); };
    const ready = (): void => { server.off("error", fail); resolve(); };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen(port, address);
  });
}

function waitForConnect(socket: Socket, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("error", failed);
      socket.off("close", closed);
      signal.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const connected = (): void => finish();
    const failed = (): void => finish(new Error("Upstream connection failed"));
    const closed = (): void => finish(new Error("Upstream closed before connecting"));
    const aborted = (): void => finish(new Error("Connection cancelled"));
    const timer = setTimeout(() => finish(new Error("Upstream connection timed out")), timeoutMs);
    timer.unref();
    socket.once("connect", connected);
    socket.once("error", failed);
    socket.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else if (!socket.connecting && socket.remoteAddress !== undefined) connected();
  });
}

/** Config is validated again here so embedded callers get the same startup guarantees as main. */
export function createEgress(options: EgressOptions) {
  const config = EgressConfig.parse(options.config);
  if (options.controlToken.length === 0 || /\s/.test(options.controlToken)) throw new Error("Control token must be nonempty and contain no whitespace");
  const endpoints = new Set<string>();
  for (const endpoint of [...config.listeners, config.control]) {
    const key = `${endpoint.address}:${endpoint.port}`;
    if (endpoints.has(key)) throw new Error("Egress listener addresses and ports must be unique");
    endpoints.add(key);
  }
  const names = new Set(config.listeners.map((listener) => listener.name));
  if (names.size !== config.listeners.length) throw new Error("Egress listener names must be unique");

  const resolver = options.resolver ?? new Resolver({ timeout: config.connectTimeoutMs, tries: 1 });
  if (options.resolver === undefined) (resolver as Resolver).setServers(config.resolvers);
  const connector = options.connector ?? ((target: ConnectTarget) => createConnection({ host: target.address, port: target.port, family: target.family }));
  const now = options.now ?? Date.now;
  const tokenDigest = createHash("sha256").update(options.controlToken).digest();
  const decisions = new DecisionStore();
  const connections = new Set<TrackedConnection>();
  const sockets = new Set<Socket>();
  const polls = new Set<AbortController>();
  const usedClients = new WeakSet<Duplex>();
  let snapshot: EgressPolicySnapshot | undefined;
  let lifecycle: "created" | "starting" | "running" | "closed" = "created";

  function record(listener: EgressListener, target: Pick<Target, "host" | "port">, method: string, decision: EgressDecision): void {
    const event = decisions.append({
      at: new Date(now()).toISOString(), agentId: listener.agentId, listener: listener.kind,
      host: target.host, port: target.port, method, decision, policyRevision: snapshot?.revision ?? 0,
    });
    // Only the shared decision fields are exposed. Request URLs, headers and bodies never enter this path.
    (options.onDecision ?? ((entry: EgressDecisionEvent) => process.stdout.write(`${JSON.stringify(entry)}\n`)))(event);
  }

  function forget(connection: TrackedConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    connections.delete(connection);
    connection.cancellation.abort();
    if (connection.expiryTimer !== null) clearTimeout(connection.expiryTimer);
    connection.forwarded?.destroy();
    connection.upstream?.destroy();
  }
  function destroy(connection: TrackedConnection): void {
    forget(connection);
    connection.client.destroy();
  }
  function authorization(connection: TrackedConnection) {
    return authorizeHost(snapshot?.agents[connection.listener.agentId], connection.listener.kind, connection.target.host, now(), connection.taskId);
  }
  function revalidate(connection: TrackedConnection): boolean {
    if (connection.closed) return false;
    if (connection.expiryTimer !== null) clearTimeout(connection.expiryTimer);
    const result = authorization(connection);
    if (result.decision !== "allowed") {
      record(connection.listener, connection.target, connection.method, result.decision);
      connection.decided = true;
      destroy(connection);
      return false;
    }
    if (result.expiresAt !== null) {
      // Node timers have a signed 32-bit limit. Long grants are rechecked rather than overflowing the timer.
      connection.expiryTimer = setTimeout(() => revalidate(connection), Math.min(2_147_483_647, Math.max(1, result.expiresAt - now())));
      connection.expiryTimer.unref();
    }
    return true;
  }

  async function resolveHost(host: string, signal: AbortSignal): Promise<string[]> {
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        (async () => {
          const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
          const addresses: string[] = [];
          for (const answer of answers) {
            if (answer.status === "fulfilled") addresses.push(...answer.value);
            else {
              const code = (answer.reason as NodeJS.ErrnoException | undefined)?.code;
              // ENODATA and NXDOMAIN mean this family has no records. Other errors leave the answer unverified.
              if (code !== "ENODATA" && code !== "ENOTFOUND" && code !== "ENONAME") throw new Error("DNS resolution failed");
            }
          }
          return addresses;
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("DNS resolution timed out")), config.connectTimeoutMs);
          timer.unref();
          abort = () => reject(new Error("DNS resolution cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort !== undefined) signal.removeEventListener("abort", abort);
    }
  }

  async function handleProxy(listener: EgressListener, request: IncomingMessage, response: ServerResponse | null, client: Duplex, head: Buffer): Promise<void> {
    const method = request.method ?? "UNKNOWN";
    if (usedClients.has(client)) {
      record(listener, { host: "", port: 0 }, method, "blocked_method");
      client.destroy();
      return;
    }
    usedClients.add(client);
    const parsed = parseTarget(method, request.url ?? "", listener.kind);
    if ("decision" in parsed) {
      record(listener, parsed, method, parsed.decision);
      refuse(client, response, parsed.decision, parsed.status);
      return;
    }
    const target = parsed.target;
    const policy = snapshot?.agents[listener.agentId];
    const initial = authorizeHost(policy, listener.kind, target.host, now());
    if (initial.decision !== "allowed") {
      record(listener, target, method, initial.decision);
      refuse(client, response, initial.decision, 403);
      return;
    }
    // Host validation precedes DNS too: a mismatched header must not leak an otherwise refused name.
    const hostHeaders = request.rawHeaders.filter((_header, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === "host");
    if (!target.connect && (hostHeaders.length > 1 || (request.headers.host !== undefined && !hostHeaderMatches(request.headers.host, target.host)))) {
      record(listener, target, method, "blocked_domain");
      refuse(client, response, "blocked_domain", 400);
      return;
    }
    const connection: TrackedConnection = {
      listener, target, method, taskId: listener.kind === "browser" ? policy!.browser.currentTaskId : null,
      policyRevision: snapshot!.revision, client, upstream: null, forwarded: null,
      cancellation: new AbortController(), expiryTimer: null, closed: false, decided: false,
    };
    connections.add(connection);
    client.once("close", () => forget(connection));
    request.once("aborted", () => destroy(connection));
    request.on("error", () => destroy(connection));
    response?.on("error", () => destroy(connection));
    if (!revalidate(connection)) return;
    const fail = (decision: EgressDecision): void => {
      if (connection.closed) return;
      if (!connection.decided) record(listener, target, method, decision);
      connection.decided = true;
      forget(connection);
      refuse(client, response, decision, 502);
    };
    let addresses: string[];
    try { addresses = await resolveHost(target.host, connection.cancellation.signal); }
    catch { fail("dns_failed"); return; }
    if (connection.closed) return;
    if (addresses.length === 0) { fail("dns_failed"); return; }
    if (addresses.some((address) => !isPublicAddress(address, config.hostAddresses))) {
      record(listener, target, method, "blocked_address");
      connection.decided = true;
      forget(connection);
      refuse(client, response, "blocked_address", 403);
      return;
    }
    addresses.sort((a, b) => isIP(a) - isIP(b));
    const address = addresses[0]!;
    if (!revalidate(connection)) return;
    try {
      const upstream = connector({ address, port: target.port, family: isIP(address) === 4 ? 4 : 6 });
      connection.upstream = upstream;
      // Keep an error listener installed even during teardown, after pending-connect listeners are removed.
      upstream.on("error", () => {
        if (connection.decided) destroy(connection);
      });
      await waitForConnect(upstream, config.connectTimeoutMs, connection.cancellation.signal);
      if (connection.closed || !revalidate(connection)) return;
      upstream.setTimeout(config.idleTimeoutMs, () => destroy(connection));
      request.socket.setTimeout(config.idleTimeoutMs, () => destroy(connection));
      record(listener, target, method, "allowed");
      connection.decided = true;
      if (target.connect) {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.once("close", () => destroy(connection));
        client.pipe(upstream);
        upstream.pipe(client);
      } else {
        if (response === null) throw new Error("HTTP response object is missing");
        const headers = filteredHeaders(request.headers);
        headers.host = target.host;
        const hasBody = request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? "0") > 0;
        if (hasBody && headers["content-length"] === undefined) {
          // Reframe decoded incoming bodies, including GET bodies. Otherwise a Connection-nominated
          // Content-Length could leave unframed bytes that the upstream parses as another request.
          headers["transfer-encoding"] = "chunked";
        }
        const agent = new Agent({ keepAlive: false });
        agent.createConnection = () => upstream;
        const forwarded = httpRequest({ host: address, port: target.port, method, path: target.path, headers, agent }, (upstreamResponse) => {
          if (connection.closed) { upstreamResponse.destroy(); return; }
          if (upstreamResponse.statusCode === undefined) {
            upstreamResponse.destroy();
            fail("connect_failed");
            return;
          }
          response.shouldKeepAlive = false;
          response.writeHead(upstreamResponse.statusCode, filteredHeaders(upstreamResponse.headers));
          upstreamResponse.on("error", () => destroy(connection));
          upstreamResponse.pipe(response);
        });
        connection.forwarded = forwarded;
        forwarded.on("error", () => {
          if (connection.closed) return;
          if (!response.headersSent) refuse(client, response, "connect_failed", 502);
          else client.destroy();
          forget(connection);
        });
        client.once("close", () => agent.destroy());
        if (request.headers.expect?.toLowerCase() === "100-continue") response.writeContinue();
        request.pipe(forwarded);
      }
    } catch { fail("connect_failed"); }
  }

  function attachServer(server: Server): void {
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.setTimeout(config.idleTimeoutMs, (socket) => socket.destroy());
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    });
  }

  const proxyServers = config.listeners.map((listener) => {
    const server = createServer();
    const handle = (request: IncomingMessage, response: ServerResponse | null, client: Duplex, head: Buffer): void => {
      request.on("error", () => client.destroy());
      response?.on("error", () => client.destroy());
      void handleProxy(listener, request, response, client, head).catch(() => {
        record(listener, { host: "", port: 0 }, request.method ?? "UNKNOWN", "connect_failed");
        refuse(client, response, "connect_failed", 502);
      });
    };
    server.on("request", (request, response) => handle(request, response, request.socket, Buffer.alloc(0)));
    server.on("connect", (request, socket, head) => handle(request, null, socket, head));
    // HTTP upgrades would escape HTTP message framing. CONNECT is the only supported tunnel mechanism.
    server.on("upgrade", (request, socket) => {
      record(listener, { host: "", port: 0 }, request.method ?? "UNKNOWN", "blocked_method");
      refuse(socket, null, "blocked_method", 405);
    });
    server.on("checkContinue", (request, response) => handle(request, response, request.socket, Buffer.alloc(0)));
    server.on("checkExpectation", (request, response) => {
      record(listener, { host: "", port: 0 }, request.method ?? "UNKNOWN", "blocked_method");
      refuse(request.socket, response, "blocked_method", 405);
    });
    server.on("clientError", (_error, socket) => {
      record(listener, { host: "", port: 0 }, "UNKNOWN", "blocked_method");
      refuse(socket, null, "blocked_method", 405);
    });
    attachServer(server);
    return { listener, server };
  });

  function connectionSummary() {
    const agents: Record<string, Record<"cli" | "browser", { count: number; hosts: string[] }>> = {};
    for (const listener of config.listeners) agents[listener.agentId] ??= { cli: { count: 0, hosts: [] }, browser: { count: 0, hosts: [] } };
    for (const connection of connections) {
      const group = agents[connection.listener.agentId]![connection.listener.kind];
      group.count++;
      if (!group.hosts.includes(connection.target.host)) group.hosts.push(connection.target.host);
    }
    for (const kinds of Object.values(agents)) for (const group of Object.values(kinds)) group.hosts.sort();
    return { agents };
  }

  function controlAuthorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const digest = createHash("sha256").update(token).digest();
    const matches = timingSafeEqual(digest, tokenDigest);
    const headerCount = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "authorization").length;
    return matches && headerCount === 1;
  }

  async function handleControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!controlAuthorized(request)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://control.invalid");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, revision: snapshot?.revision ?? 0 });
    } else if (request.method === "PUT" && url.pathname === "/v1/policy") {
      let candidate: EgressPolicySnapshot;
      try {
        candidate = EgressPolicySnapshot.parse(await readJson(request));
        for (const policy of Object.values(candidate.agents)) {
          for (const rule of policy.browser.rules) {
            if (rule.expiresAt !== null && !Number.isFinite(Date.parse(rule.expiresAt))) throw new Error("Invalid rule expiry");
          }
        }
      } catch { sendJson(response, 400, { error: "Expected a valid JSON egress policy snapshot with valid expiry dates" }); return; }
      if (candidate.revision <= (snapshot?.revision ?? 0)) {
        sendJson(response, 409, { error: "Policy revision must increase" });
        return;
      }
      snapshot = candidate;
      for (const connection of [...connections]) revalidate(connection);
      sendJson(response, 200, { ok: true, revision: snapshot.revision });
    } else if (request.method === "GET" && url.pathname === "/v1/decisions") {
      const afterText = url.searchParams.get("after") ?? "0";
      const waitText = url.searchParams.get("wait") ?? "0";
      const after = Number(afterText);
      const wait = Number(waitText);
      if (!/^\d+$/.test(afterText) || !Number.isSafeInteger(after) || !/^(?:\d+)(?:\.\d+)?$/.test(waitText) || !Number.isFinite(wait) || wait < 0 || wait > 25) {
        sendJson(response, 400, { error: "after must be a nonnegative integer and wait must be between 0 and 25 seconds" });
        return;
      }
      const cancellation = new AbortController();
      const abort = (): void => cancellation.abort();
      polls.add(cancellation);
      response.once("close", abort);
      try {
        const result: EgressDecisionsResponse = { epoch: decisions.epoch, events: await decisions.wait(after, wait * 1000, cancellation.signal) };
        sendJson(response, 200, result);
      }
      finally { polls.delete(cancellation); response.off("close", abort); }
    } else if (request.method === "POST" && /^\/v1\/agents\/[^/]+\/freeze$/.test(url.pathname)) {
      const agentId = AgentId.safeParse(url.pathname.split("/")[3]);
      if (!agentId.success) { sendJson(response, 400, { error: "Invalid agent id" }); return; }
      if (request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? "0") > 0) {
        try { await readJson(request); }
        catch { sendJson(response, 400, { error: "Expected a JSON body" }); return; }
      }
      const policy = snapshot?.agents[agentId.data];
      if (policy !== undefined) policy.frozen = true;
      let closed = 0;
      for (const connection of [...connections]) {
        if (connection.listener.agentId === agentId.data) {
          record(connection.listener, connection.target, connection.method, "frozen");
          destroy(connection);
          closed++;
        }
      }
      sendJson(response, 200, { closed });
    } else if (request.method === "GET" && url.pathname === "/v1/connections") {
      sendJson(response, 200, connectionSummary());
    } else sendJson(response, 404, { error: "Not found" });
  }

  const controlServer = createServer((request, response) => {
    request.on("error", () => response.destroy());
    response.on("error", () => response.destroy());
    void handleControl(request, response).catch(() => sendJson(response, 500, { error: "Control request failed" }));
  });
  const rejectControlTunnel = (request: IncomingMessage, socket: Duplex): void => {
    const authorized = controlAuthorized(request);
    const body = JSON.stringify({ error: authorized ? "Method not allowed" : "Unauthorized" });
    const status = authorized ? "405 Method Not Allowed" : "401 Unauthorized";
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  controlServer.on("connect", rejectControlTunnel);
  controlServer.on("upgrade", rejectControlTunnel);
  controlServer.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 23\r\n\r\n{\"error\":\"Bad request\"}"));
  attachServer(controlServer);
  // A 25-second control long poll must outlive even a very short sandbox tunnel idle timeout.
  controlServer.setTimeout(30_000, (socket) => socket.destroy());
  const servers = [...proxyServers.map(({ server }) => server), controlServer];

  async function close(): Promise<void> {
    if (lifecycle === "closed") return;
    lifecycle = "closed";
    for (const poll of polls) poll.abort();
    for (const connection of [...connections]) destroy(connection);
    // Only the resolver owned by this instance may be cancelled. Injected resolvers can be shared by callers.
    if (options.resolver === undefined) (resolver as Resolver).cancel();
    const closing = servers.map((server) => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close((error) => error === undefined ? resolve() : reject(error));
    }));
    for (const socket of sockets) socket.destroy();
    await Promise.all(closing);
  }

  return {
    async start(): Promise<void> {
      if (lifecycle !== "created") throw new Error("Egress can only be started once");
      lifecycle = "starting";
      try {
        for (const { server, listener } of proxyServers) await listen(server, listener.address, listener.port);
        await listen(controlServer, config.control.address, config.control.port);
        lifecycle = "running";
      } catch (error) { await close(); throw error; }
    },
    close,
    addresses(): { control: AddressInfo; listeners: { name: string; address: AddressInfo }[] } {
      const address = (server: Server): AddressInfo => {
        const value = server.address();
        if (value === null || typeof value === "string") throw new Error("Egress is not listening");
        return value;
      };
      return { control: address(controlServer), listeners: proxyServers.map(({ listener, server }) => ({ name: listener.name, address: address(server) })) };
    },
  };
}
