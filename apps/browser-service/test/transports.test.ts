import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { expect, it } from "vitest";
import { BrowserCdp } from "../src/cdp.js";
import { Downloads } from "../src/downloads.js";
import { systemClock } from "../src/runtime.js";
import { GUID, harness, RUN_ID, until } from "./helpers.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP port");
  return address.port;
}
function socketUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES";
}
it("uses a fake CDP WebSocket server for request correlation, download events and disconnects", async (context) => {
  let port = 0;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }));
  });
  const ws = new WebSocketServer({ server });
  ws.on("error", () => { /* The HTTP listener reports sandbox socket refusals below. */ });
  let peer: WebSocket | undefined;
  const calls: { id: number; method: string; params: unknown }[] = [];
  ws.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; method: string; params: unknown };
      calls.push(message);
      socket.send(JSON.stringify({ id: message.id, result: { acknowledged: true } }));
    });
  });
  try { port = await listen(server); }
  catch (error) {
    ws.close(); server.close();
    if (socketUnavailable(error)) { console.warn(`CDP socket test cannot listen: ${(error as Error).message}`); context.skip("sandbox refuses loopback listening sockets"); }
    throw error;
  }
  const root = await mkdtemp(join(tmpdir(), "quokkabot-cdp-test-"));
  const cdp = new BrowserCdp(`http://127.0.0.1:${port}/json/version`, 1000);
  try {
    const downloads = new Downloads(root, systemClock, cdp); await downloads.load();
    let events = Promise.resolve();
    cdp.on("event", (method, params) => { events = events.then(() => downloads.event(method, params, undefined)); });
    await cdp.connect();
    expect(cdp.connected).toBe(true);
    expect(await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: root, eventsEnabled: true })).toEqual({ acknowledged: true });
    peer!.send(JSON.stringify({ method: "Browser.downloadWillBegin", params: { guid: GUID, url: "https://example.com/file", suggestedFilename: "file.pdf" } }));
    peer!.send(JSON.stringify({ method: "Browser.downloadProgress", params: { guid: GUID, receivedBytes: 4, totalBytes: 4, state: "completed" } }));
    await until(async () => { await events; return downloads.list()[0]?.state === "completed"; });
    expect(downloads.list()[0]).toMatchObject({ guid: GUID, receivedBytes: 4, commandId: null });
    expect(calls[0]?.method).toBe("Browser.setDownloadBehavior");
    cdp.close();
    await until(async () => !cdp.connected);
  } finally {
    cdp.close(); for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("serves the authenticated API over Node HTTP", async (context) => {
  const h = await harness();
  try {
    let port: number;
    try { port = await listen(h.service.server); }
    catch (error) {
      if (socketUnavailable(error)) { console.warn(`HTTP socket test cannot listen: ${(error as Error).message}`); context.skip("sandbox refuses loopback listening sockets"); }
      throw error;
    }
    const origin = `http://127.0.0.1:${port}`;
    expect((await fetch(`${origin}/health`)).status).toBe(401);
    const health = await fetch(`${origin}/health`, { headers: { authorization: "Bearer test-token" } });
    expect(health.status).toBe(200); expect(await health.json()).toMatchObject({ chrome: "up", cdp: true, agentBrowserReady: true });
    const malformed = await fetch(`${origin}/v1/control-lease`, { method: "PUT", headers: { authorization: "Bearer test-token" }, body: "{" });
    expect(malformed.status).toBe(400);
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    const secret = await fetch(`${origin}/v1/secret-fill`, {
      method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ commandId: "http_secret_fill", runId: RUN_ID, generation: 2, tab: "t1", snapshot: snapshot.snapshot,
        ref: "e2", kind: "password", value: "http-secret-canary", allowedPatterns: ["example.com"], submit: false }),
    });
    expect(secret.status).toBe(200);
    expect(await secret.json()).toEqual({ commandId: "http_secret_fill", status: "ok" });
    expect(h.cdp.frames[0]?.inserted).toBe("http-secret-canary");
  } finally {
    h.service.server.closeAllConnections();
    if (h.service.server.listening) await new Promise<void>((resolve) => h.service.server.close(() => resolve()));
    await h.cleanup();
  }
});
