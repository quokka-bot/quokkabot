import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server as HttpServer } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { Socket } from "node:net";
import type { Server as TcpServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentId, EgressConfig, EgressDecisionEvent, EgressDecisionsResponse, EgressPolicySnapshot, TaskId } from "@quokkabot/shared";
import { createEgress } from "../src/egress.js";
import type { ConnectTarget, DnsResolver, EgressOptions } from "../src/egress.js";

const agent = AgentId.parse("00000000-0000-4000-8000-000000000001");
const secondAgent = AgentId.parse("00000000-0000-4000-8000-000000000002");
const task = TaskId.parse("00000000-0000-4000-8000-000000000003");
const token = "test-control-token";
const cleanup: (() => void | Promise<void>)[] = [];

// Only the documented platform restriction skips these tests. Binding failures such as EADDRINUSE still fail.
async function loopbackIsAvailable(): Promise<boolean> {
  const server = createTcpServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    console.warn("Egress socket integration tests unavailable: listen EPERM/EACCES on 127.0.0.1");
    return false;
  }
}
const loopbackAvailable = await loopbackIsAvailable();

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function localServer(server: TcpServer | HttpServer): Promise<number> {
  const clients = new Set<Socket>();
  server.on("connection", (socket) => {
    clients.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => clients.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    for (const client of clients) client.destroy();
  }));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture did not bind TCP");
  return address.port;
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  const port = await localServer(server);
  await cleanup.pop()!();
  return port;
}

function policy(revision = 1) {
  return EgressPolicySnapshot.parse({ revision, agents: {
    [agent]: { frozen: false, cli: { allow: ["api.anthropic.com"] }, browser: {
      currentTaskId: task, attendedOpen: false,
      rules: [{ pattern: "*.example.com", attended: false, taskId: null, expiresAt: null }],
    } },
    [secondAgent]: { frozen: false, cli: { allow: [] }, browser: {
      currentTaskId: null, attendedOpen: false,
      rules: [{ pattern: "second.test", attended: false, taskId: null, expiresAt: null }],
    } },
  } });
}
interface ControlResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
async function control(port: number, method: string, path: string, body?: unknown, credential: string | null = token): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (credential !== null) headers.authorization = `Bearer ${credential}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function setup(overrides: Partial<Pick<EgressOptions, "resolver" | "connector" | "now">> & { config?: Partial<EgressConfig> } = {}) {
  const ports = new Set<number>();
  while (ports.size < 4) ports.add(await freePort());
  const [browser, cli, other, controlPort] = [...ports] as [number, number, number, number];
  const config = EgressConfig.parse({
    listeners: [
      { name: "browser-1", address: "127.0.0.1", port: browser, agentId: agent, kind: "browser" },
      { name: "cli-1", address: "127.0.0.1", port: cli, agentId: agent, kind: "cli" },
      { name: "browser-2", address: "127.0.0.1", port: other, agentId: secondAgent, kind: "browser" },
    ],
    control: { address: "127.0.0.1", port: controlPort, tokenFile: "/unused-in-factory" },
    resolvers: ["1.1.1.1"], connectTimeoutMs: 200, idleTimeoutMs: 1000, ...overrides.config,
  });
  const resolve4 = vi.fn(async (_host: string) => ["8.8.8.8"]);
  const resolve6 = vi.fn(async (_host: string) => [] as string[]);
  const events: EgressDecisionEvent[] = [];
  const connector = overrides.connector ?? vi.fn((_target: ConnectTarget): Socket => { throw new Error("Unexpected connection"); });
  const egress = createEgress({ config, controlToken: token, resolver: overrides.resolver ?? { resolve4, resolve6 }, connector, onDecision: (event) => {
    EgressDecisionEvent.parse(event);
    events.push(event);
  }, ...(overrides.now === undefined ? {} : { now: overrides.now }) });
  await egress.start();
  cleanup.push(egress.close);
  return {
    egress, browser, cli, other, controlPort, resolve4, resolve6, connector, events,
    push: (snapshot: EgressPolicySnapshot = policy()) => control(controlPort, "PUT", "/v1/policy", snapshot),
  };
}

async function socketTo(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  cleanup.push(() => { socket.destroy(); });
  await once(socket, "connect");
  return socket;
}
function readUntil(socket: Socket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const onData = (chunk: Buffer): void => {
      text += chunk.toString();
      if (text.includes(marker)) { remove(); resolve(text); }
    };
    const onClose = (): void => { remove(); reject(new Error(`Socket closed before ${JSON.stringify(marker)}: ${text}`)); };
    const onError = (error: Error): void => { remove(); reject(error); };
    const remove = (): void => { socket.off("data", onData); socket.off("close", onClose); socket.off("error", onError); };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}
async function rawRequest(port: number, message: string): Promise<string> {
  const socket = await socketTo(port);
  const closed = once(socket, "close");
  const parts: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => parts.push(chunk));
  socket.write(message);
  await closed;
  return Buffer.concat(parts).toString();
}
async function tunnel(port: number, host = "example.com", extra = ""): Promise<Socket> {
  const socket = await socketTo(port);
  const header = readUntil(socket, "\r\n\r\n");
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${extra}\r\n`);
  expect(await header).toContain("200 Connection Established");
  return socket;
}
async function echoServer(): Promise<number> {
  return localServer(createTcpServer((socket) => socket.pipe(socket)));
}
function localConnector(port: number) {
  return vi.fn((target: ConnectTarget) => {
    expect(target).toMatchObject({ address: "8.8.8.8", family: 4 });
    return createConnection({ host: "127.0.0.1", port });
  });
}

describe.skipIf(!loopbackAvailable)("real proxy and control listeners", () => {
  it("fails closed before a snapshot and authenticates every control route", async () => {
    const s = await setup();
    const denied = await rawRequest(s.browser, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    expect(denied).toContain("403 Forbidden");
    expect(denied).toContain("X-Quokkabot-Decision: frozen");
    expect(s.resolve4).not.toHaveBeenCalled();
    for (const credential of [null, "wrong", token + "more", "short"]) {
      for (const [method, path, body] of [["GET", "/health", undefined], ["PUT", "/v1/policy", policy()], ["POST", `/v1/agents/${agent}/freeze`, undefined]] as const) {
        expect((await control(s.controlPort, method, path, body, credential)).status).toBe(401);
      }
    }
    expect(JSON.parse((await control(s.controlPort, "GET", "/health")).body)).toEqual({ ok: true, revision: 0 });
    expect((await s.push()).status).toBe(200);
    expect((await s.push()).status).toBe(409);
    expect((await s.push(policy(2))).status).toBe(200);
    expect((await s.push()).status).toBe(409);
  });

  it("pipes CONNECT bytes, including head bytes, to the validated IPv4 address first", async () => {
    const port = await echoServer();
    const connector = localConnector(port);
    const resolver: DnsResolver = { resolve4: async () => ["8.8.8.8"], resolve6: async () => ["2606:4700::1111"] };
    const s = await setup({ connector, resolver });
    await s.push();
    const socket = await socketTo(s.browser);
    const handshake = readUntil(socket, "early-data");
    socket.write("CONNECT EXAMPLE.COM.:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\nearly-data");
    expect(await handshake).toContain("200 Connection Established\r\n\r\nearly-data");
    const reply = readUntil(socket, "ping");
    socket.write("ping");
    expect(await reply).toBe("ping");
    expect(connector).toHaveBeenCalledWith({ address: "8.8.8.8", family: 4, port: 443 });
    expect(s.events).toMatchObject([{ host: "example.com", decision: "allowed", listener: "browser", agentId: agent, policyRevision: 1 }]);
    const summary = JSON.parse((await control(s.controlPort, "GET", "/v1/connections")).body);
    expect(summary.agents[agent].browser).toEqual({ count: 1, hosts: ["example.com"] });
  });

  it("authorizes before DNS and binds identities to listeners rather than headers", async () => {
    const s = await setup();
    await s.push();
    for (const [port, request, decision] of [
      [s.browser, "CONNECT refused.test:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: browser-2\r\n\r\n", "blocked_domain"],
      [s.other, "CONNECT example.com:443 HTTP/1.1\r\nHost: second.test:443\r\nX-Agent-Id: " + agent + "\r\n\r\n", "blocked_domain"],
      [s.browser, "CONNECT example.com:8443 HTTP/1.1\r\n\r\n", "blocked_port"],
      [s.browser, "GET http://example.com:8080/ HTTP/1.1\r\nHost: example.com\r\n\r\n", "blocked_port"],
      [s.cli, "GET http://api.anthropic.com/ HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n", "blocked_method"],
      [s.browser, "GET /path?secret=hidden HTTP/1.1\r\nHost: example.com\r\n\r\n", "blocked_method"],
      [s.browser, "CONNECT 0177.0.0.1:443 HTTP/1.1\r\n\r\n", "blocked_ip_literal"],
    ] as const) expect(await rawRequest(port, request)).toContain(`X-Quokkabot-Decision: ${decision}`);
    expect(s.resolve4).not.toHaveBeenCalled();
    expect(s.resolve6).not.toHaveBeenCalled();
    expect(s.connector).not.toHaveBeenCalled();
    expect(s.events[1]).toMatchObject({ agentId: secondAgent, listener: "browser" });
    expect(JSON.stringify(s.events)).not.toContain("hidden");
    expect(JSON.stringify(s.events)).not.toContain("Proxy-Authorization");
  });

  it.each([
    [["8.8.8.8", "10.0.0.1"], [], "blocked_address"],
    [["8.8.8.8"], ["::1"], "blocked_address"],
    [["8.8.8.8"], ["::ffff:192.168.1.1"], "blocked_address"],
    [[], [], "dns_failed"],
  ] as const)("rejects DNS answers %j and %j", async (v4, v6, decision) => {
    const s = await setup({ resolver: { resolve4: async () => [...v4], resolve6: async () => [...v6] } });
    await s.push();
    expect(await rawRequest(s.browser, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toContain(`X-Quokkabot-Decision: ${decision}`);
    expect(s.connector).not.toHaveBeenCalled();
  });

  it("forwards origin-form HTTP, streams bodies and strips hop-by-hop headers in both directions", async () => {
    let observed: { url: string | undefined; method: string | undefined; headers: IncomingHttpHeaders; body: string } | undefined;
    const upstreamPort = await localServer(createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        observed = { url: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() };
        response.writeHead(200, { "Content-Type": "text/plain", "Connection": "close, x-private", "X-Private": "response-secret", "Proxy-Authenticate": "secret", "Set-Cookie": ["a=b", "c=d"] });
        response.end("upstream body");
      });
    }));
    const s = await setup({ connector: localConnector(upstreamPort) });
    await s.push();
    const reply = await rawRequest(s.browser, "POST http://EXAMPLE.com./invoice?secret=query HTTP/1.1\r\nHost: example.com:80\r\nProxy-Authorization: secret-token\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive, x-remove\r\nX-Remove: secret-header\r\nKeep-Alive: timeout=120\r\nTE: trailers\r\nX-Keep: yes\r\nContent-Length: 4\r\n\r\ndata");
    expect(reply).toContain("200 OK");
    expect(reply).toContain("upstream body");
    expect(reply.toLowerCase()).toContain("connection: close");
    expect(reply.toLowerCase()).not.toContain("x-private");
    expect(reply.toLowerCase()).not.toContain("proxy-authenticate");
    expect(reply.toLowerCase()).toContain("set-cookie: a=b");
    expect(reply.toLowerCase()).toContain("set-cookie: c=d");
    expect(observed).toMatchObject({ url: "/invoice?secret=query", method: "POST", body: "data", headers: { host: "example.com", "x-keep": "yes", connection: "close" } });
    for (const name of ["proxy-authorization", "proxy-connection", "x-remove", "keep-alive", "te"]) expect(observed!.headers[name]).toBeUndefined();
    expect(JSON.stringify(s.events)).not.toMatch(/invoice|query|secret-token|secret-header|upstream body/);
    expect(s.connector).toHaveBeenCalledWith({ address: "8.8.8.8", family: 4, port: 80 });
    expect(s.connector).toHaveBeenCalledTimes(1);
    expect(await rawRequest(s.browser, "GET http://example.com/ HTTP/1.1\r\nHost: attacker.test\r\n\r\n")).toContain("400 Bad Request");
    expect(s.connector).toHaveBeenCalledTimes(1);
    expect(s.resolve4).toHaveBeenCalledTimes(1);
  });



  it("cleans up partial HTTP uploads when the client disconnects", async () => {
    const started = Promise.withResolvers<void>();
    let upstreamRequestClosed: Promise<void> | undefined;
    const upstreamPort = await localServer(createHttpServer((request) => {
      request.on("error", () => {});
      // The cut body is a parse error on the upstream socket before it closes; wait for the close only.
      request.socket.on("error", () => {});
      upstreamRequestClosed = new Promise((resolve) => request.socket.once("close", () => resolve()));
      started.resolve();
    }));
    const s = await setup({ connector: localConnector(upstreamPort) });
    await s.push();
    const socket = await socketTo(s.browser);
    socket.write("POST http://example.com/ HTTP/1.1\r\nHost: example.com\r\nContent-Length: 100\r\n\r\npartial");
    await started.promise;
    socket.destroy();
    await upstreamRequestClosed;
    const result = JSON.parse((await control(s.controlPort, "GET", "/v1/connections")).body);
    expect(result.agents[agent].browser.count).toBe(0);
  });

  it("reframes GET bodies when a hop-by-hop declaration removes their original length", async () => {
    const observed: { headers: IncomingHttpHeaders; body: string }[] = [];
    const upstreamPort = await localServer(createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        observed.push({ headers: request.headers, body: Buffer.concat(chunks).toString() });
        response.end("framed");
      });
    }));
    const s = await setup({ connector: localConnector(upstreamPort) });
    await s.push();
    const body = "GET /smuggled HTTP/1.1\r\nHost: attacker.test\r\n\r\n";
    const reply = await rawRequest(s.browser, `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: content-length\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    expect(reply).toContain("framed");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.body).toBe(body);
    expect(observed[0]!.headers["transfer-encoding"]).toBe("chunked");
    expect(observed[0]!.headers["content-length"]).toBeUndefined();
  });

  it("allows GET with no Host header and refuses a second pipelined request", async () => {
    const paths: string[] = [];
    const upstreamPort = await localServer(createHttpServer((request, response) => { paths.push(request.url!); response.end("ok"); }));
    const s = await setup({ connector: localConnector(upstreamPort) });
    await s.push();
    expect(await rawRequest(s.browser, "GET http://example.com/first HTTP/1.0\r\n\r\n")).toContain("ok");
    await rawRequest(s.browser, "GET http://example.com/one HTTP/1.1\r\nHost: example.com\r\n\r\nGET http://example.com/two HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect(paths).toEqual(["/first"]);
  });

  it("revokes only the affected tunnels on policy changes and freezes immediately", async () => {
    const s = await setup({ connector: localConnector(await echoServer()) });
    await s.push();
    const browser = await tunnel(s.browser);
    const cli = await tunnel(s.cli, "api.anthropic.com");
    const other = await tunnel(s.other, "second.test");
    const browserClosed = once(browser, "close");
    const next = policy(2);
    next.agents[agent]!.browser.rules = [];
    expect((await s.push(next)).status).toBe(200);
    await browserClosed;
    expect(cli.destroyed).toBe(false);
    expect(other.destroyed).toBe(false);
    const cliClosed = once(cli, "close");
    const freeze = await control(s.controlPort, "POST", `/v1/agents/${agent}/freeze`);
    expect(JSON.parse(freeze.body)).toEqual({ closed: 1 });
    await cliClosed;
    expect(other.destroyed).toBe(false);
    expect(await rawRequest(s.cli, "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n")).toContain("X-Quokkabot-Decision: frozen");
    expect((await s.push(policy(3))).status).toBe(200);
    const unfrozen = await tunnel(s.browser);
    const reply = readUntil(unfrozen, "back");
    unfrozen.write("back");
    expect(await reply).toBe("back");
  });

  it("revokes pending DNS work and never connects after a freeze", async () => {
    let answer: ((addresses: string[]) => void) | undefined;
    const called = Promise.withResolvers<void>();
    const resolve4 = vi.fn(() => { called.resolve(); return new Promise<string[]>((resolve) => { answer = resolve; }); });
    const s = await setup({ resolver: { resolve4, resolve6: async () => [] } });
    await s.push();
    const socket = await socketTo(s.browser);
    const closed = once(socket, "close");
    socket.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
    await called.promise;
    expect(JSON.parse((await control(s.controlPort, "POST", `/v1/agents/${agent}/freeze`)).body)).toEqual({ closed: 1 });
    answer!(["8.8.8.8"]);
    await closed;
    expect(s.connector).not.toHaveBeenCalled();
    expect(s.events.at(-1)!.decision).toBe("frozen");
  });

  it("closes tunnels when attended access ends, tasks change, grants expire or clients idle", async () => {
    let clock = Date.parse("2026-10-17T12:00:00Z");
    const s = await setup({ connector: localConnector(await echoServer()), now: () => clock });
    const p = policy();
    p.agents[agent]!.browser.rules[0]!.attended = true;
    p.agents[agent]!.browser.attendedOpen = true;
    await s.push(p);
    const attended = await tunnel(s.browser);
    const attendedClosed = once(attended, "close");
    const p2 = policy(2);
    p2.agents[agent]!.browser.rules[0]!.attended = true;
    await s.push(p2);
    await attendedClosed;
    expect(await rawRequest(s.browser, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toContain("X-Quokkabot-Decision: blocked_attended");
    await s.push(policy(3));
    const taskSocket = await tunnel(s.browser);
    const taskClosed = once(taskSocket, "close");
    const p4 = policy(4);
    p4.agents[agent]!.browser.currentTaskId = null;
    await s.push(p4);
    await taskClosed;
    const p5 = policy(5);
    p5.agents[agent]!.browser.rules[0]!.expiresAt = new Date(clock + 40).toISOString();
    await s.push(p5);
    const expiring = await tunnel(s.browser);
    const expired = once(expiring, "close");
    clock += 40;
    await expired;
    expect(s.events.at(-1)!.decision).toBe("blocked_domain");
    await s.push(policy(6));
    const idle = await tunnel(s.browser);
    await once(idle, "close");
  });


  it("reports DNS and connect failures with 502 and bounded waits", async () => {
    const noRecords = Object.assign(new Error("No records"), { code: "ENODATA" });
    const absent = await setup({ resolver: { resolve4: async () => { throw noRecords; }, resolve6: async () => { throw noRecords; } } });
    await absent.push();
    expect(await rawRequest(absent.browser, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toContain("502 Bad Gateway");
    expect(absent.events.at(-1)!.decision).toBe("dns_failed");
    const partial = await setup({ resolver: { resolve4: async () => ["8.8.8.8"], resolve6: async () => { throw new Error("Resolver timeout"); } } });
    await partial.push();
    expect(await rawRequest(partial.browser, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toContain("X-Quokkabot-Decision: dns_failed");
    expect(partial.connector).not.toHaveBeenCalled();
    const hanging = await setup({ resolver: { resolve4: () => new Promise(() => {}), resolve6: async () => [] } });
    await hanging.push();
    expect(await rawRequest(hanging.browser, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toContain("X-Quokkabot-Decision: dns_failed");
    const broken = await setup({ connector: () => { throw new Error("Cannot connect"); } });
    await broken.push();
    expect(await rawRequest(broken.browser, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toContain("X-Quokkabot-Decision: connect_failed");
  });

  it("refuses the host's own public address after resolution", async () => {
    const s = await setup({ config: { hostAddresses: ["8.8.8.8"] } });
    await s.push();
    expect(await rawRequest(s.browser, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toContain("X-Quokkabot-Decision: blocked_address");
    expect(s.connector).not.toHaveBeenCalled();
  });

  it("rechecks pending connects on policy updates", async () => {
    const called = Promise.withResolvers<void>();
    const upstreamSocket = new Socket();
    const s = await setup({ connector: () => { called.resolve(); return upstreamSocket; } });
    await s.push();
    const socket = await socketTo(s.browser);
    const closed = once(socket, "close");
    socket.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
    await called.promise;
    const next = policy(2);
    next.agents[agent]!.browser.rules = [];
    await s.push(next);
    await closed;
    expect(upstreamSocket.destroyed).toBe(true);
    expect(s.events.at(-1)!.decision).toBe("blocked_domain");
  });

  it("times out pending upstream sockets and destroys them", async () => {
    const upstreamSocket = new Socket();
    const s = await setup({ connector: () => upstreamSocket });
    await s.push();
    expect(await rawRequest(s.browser, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).toContain("X-Quokkabot-Decision: connect_failed");
    expect(upstreamSocket.destroyed).toBe(true);
  });

  it("rejects malformed policies and invalid JSON content types", async () => {
    const s = await setup();
    expect((await control(s.controlPort, "PUT", "/v1/policy", {})).status).toBe(400);
    const invalid = policy();
    invalid.agents[agent]!.browser.rules[0]!.expiresAt = "invalid-date";
    expect((await s.push(invalid)).status).toBe(400);
    expect((await control(s.controlPort, "PUT", "/v1/policy")).status).toBe(400);
    expect(JSON.parse((await control(s.controlPort, "GET", "/health")).body).revision).toBe(0);
  });

  it("closes all tracked tunnels and long polls during shutdown", async () => {
    const s = await setup({ connector: localConnector(await echoServer()) });
    await s.push();
    const socket = await tunnel(s.browser);
    const closed = once(socket, "close");
    const waiting = control(s.controlPort, "GET", "/v1/decisions?after=999&wait=25").catch((error: NodeJS.ErrnoException) => error.code);
    await s.egress.close();
    await closed;
    const result = await waiting;
    expect(typeof result === "string" || (result !== undefined && result.status === 200)).toBe(true);
    await s.egress.close();
  });

  it("long-polls decisions and validates cursors", async () => {
    const s = await setup();
    await s.push();
    const waiting = control(s.controlPort, "GET", "/v1/decisions?after=0&wait=2");
    await rawRequest(s.browser, "CONNECT refused.test:443 HTTP/1.1\r\n\r\n");
    const result = await waiting;
    expect(result.status).toBe(200);
    const decisions = EgressDecisionsResponse.parse(JSON.parse(result.body));
    expect(decisions.events).toMatchObject([{ seq: 1, host: "refused.test", decision: "blocked_domain" }]);
    expect(JSON.parse((await control(s.controlPort, "GET", "/v1/decisions?after=1&wait=0.01")).body)).toEqual({ epoch: decisions.epoch, events: [] });
    for (const query of ["after=-1", "after=no", "after=1.5", "wait=26", "wait=NaN", "wait=-1"]) {
      expect((await control(s.controlPort, "GET", `/v1/decisions?${query}`)).status).toBe(400);
    }
  });

  it("changes the API epoch when the service restarts with a new decision sequence", async () => {
    const first = await setup();
    await first.push();
    await rawRequest(first.browser, "CONNECT first-refused.test:443 HTTP/1.1\r\n\r\n");
    const before = EgressDecisionsResponse.parse(JSON.parse((await control(first.controlPort, "GET", "/v1/decisions")).body));
    expect(before.events).toMatchObject([{ seq: 1, host: "first-refused.test" }]);
    await first.egress.close();
    const second = await setup();
    await second.push();
    await rawRequest(second.browser, "CONNECT next-refused.test:443 HTTP/1.1\r\n\r\n");
    const staleCursor = EgressDecisionsResponse.parse(JSON.parse((await control(second.controlPort, "GET", "/v1/decisions?after=1")).body));
    expect(staleCursor.epoch).not.toBe(before.epoch);
    expect(staleCursor.events).toEqual([]);
    const reset = EgressDecisionsResponse.parse(JSON.parse((await control(second.controlPort, "GET", "/v1/decisions?after=0")).body));
    expect(reset.epoch).toBe(staleCursor.epoch);
    expect(reset.events).toMatchObject([{ seq: 1, host: "next-refused.test", decision: "blocked_domain" }]);
  });
});
