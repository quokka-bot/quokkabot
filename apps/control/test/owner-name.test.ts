import http from "node:http";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentSlots } from "../src/agents.js";
import { Auth, type SessionInfo } from "../src/auth.js";
import type { ControlConfig } from "../src/config.js";
import { migratedOwnerName, type Db } from "../src/db.js";
import { buildServer, type HttpDeps } from "../src/http.js";
import { McpEndpoint } from "../src/mcp.js";

// The owner's name: stored by the control plane, read and changed only with the owner's session on the app origin.

const app = { host: "quokkabot.test", origin: "https://quokkabot.test" };
const view = { host: "view.quokkabot.test", origin: "https://view.quokkabot.test" };
const COOKIE = "c".repeat(43);
const PHONE = "p".repeat(43);
// The /api/me schema the Mac app 0.2.1 and older iPhone builds shipped with.
const SHIPPED_ME = z.object({ ownerName: z.string(), passkeys: z.number().int(), freshUntil: z.string().nullable() });

async function fixture(account: { name: string | null } | null = { name: null }) {
  const config = { agents: [], appOrigin: app.origin, appHost: app.host, viewOrigin: view.origin, viewHost: view.host } as unknown as ControlConfig;
  const writes: unknown[][] = [];
  const db = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql === "select name from owner_account where id = 1") return { rows: account ? [{ name: account.name }] : [], rowCount: account ? 1 : 0 };
      if (sql === "update owner_account set name = $1 where id = 1") {
        writes.push(values);
        if (!account) return { rows: [], rowCount: 0 };
        account.name = values[0] as string;
        return { rows: [], rowCount: 1 };
      }
      if (sql === "select count(*)::int as n from passkeys") return { rows: [{ n: 1 }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  } as unknown as Db;
  const auth = new Auth(db, config, { append: vi.fn() } as never, () => []);
  // The browser's session travels in the cookie and the phone's in the Authorization header; each only that way.
  vi.spyOn(auth, "session").mockImplementation(async (token, transport): Promise<SessionInfo | null> => {
    if (token === COOKIE && transport === "cookie") return { hash: "browser", freshUntil: null, client: "browser" };
    if (token === PHONE && transport === "bearer") return { hash: "phone", freshUntil: null, client: "phone" };
    return null;
  });
  const audit = { append: vi.fn() };
  const deps = { config, db, auth, audit, log: pino({ level: "silent" }), webRoot: "/missing" } as unknown as HttpDeps;
  deps.slots = new AgentSlots(db, config, audit as never);
  const { app: server } = await buildServer(deps);
  return { server, writes, account, audit };
}

const browser = { host: app.host, origin: app.origin, cookie: `qb_session=${COOKIE}` };
const phone = { host: app.host, authorization: `Bearer ${PHONE}` };

describe("the owner's name", () => {
  it("reads as an empty string until the owner gives one, in the shape older apps parse", async () => {
    const { server } = await fixture();
    try {
      const me = await server.inject({ method: "GET", url: "/api/me", headers: browser });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({ ownerName: "", passkeys: 1, freshUntil: null });
      expect(SHIPPED_ME.safeParse(me.json()).success).toBe(true);
    } finally { await server.close(); }
  });

  it("is saved normalized from the web and Mac apps and from the phone, and read back by every device", async () => {
    const { server, account, audit } = await fixture();
    try {
      const saved = await server.inject({ method: "PUT", url: "/api/me", headers: browser, payload: { ownerName: "  E\u0301mile   Example " } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ ownerName: "Émile Example", passkeys: 1, freshUntil: null });
      expect(account?.name).toBe("Émile Example");
      const fromPhone = await server.inject({ method: "PUT", url: "/api/me", headers: phone, payload: { ownerName: "Robin" } });
      expect(fromPhone.json().ownerName).toBe("Robin");
      expect((await server.inject({ method: "GET", url: "/api/me", headers: browser })).json().ownerName).toBe("Robin");
      expect(SHIPPED_ME.safeParse(fromPhone.json()).success).toBe(true);
      expect(audit.append).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it.each([
    ["no session", { host: app.host, origin: app.origin }, 401],
    ["a cookie that is not a session", { ...browser, cookie: "qb_session=forged" }, 401],
    ["the session cookie without an Origin", { host: app.host, cookie: browser.cookie }, 403],
    ["the session cookie from the viewer origin", { ...browser, origin: view.origin }, 403],
    ["the session cookie from another site", { ...browser, origin: "https://evil.test" }, 403],
    ["the viewer host", { host: view.host, origin: view.origin, cookie: browser.cookie }, 404],
    ["an unknown host", { host: "10.231.1.3:8080", cookie: browser.cookie }, 421],
    ["the phone token from a web page's origin", { ...phone, origin: "https://evil.test" }, 403],
    ["the session cookie with an invalid bearer token", { ...browser, authorization: "Bearer forged" }, 401],
    ["the phone token sent as a cookie", { host: app.host, origin: app.origin, cookie: `qb_session=${PHONE}` }, 401],
  ])("refuses a change with %s", async (_name, headers, status) => {
    const { server, writes, account } = await fixture({ name: "Robin" });
    try {
      const response = await server.inject({ method: "PUT", url: "/api/me", headers, payload: { ownerName: "Mallory" } });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain("Robin");
      expect(writes).toEqual([]);
      expect(account?.name).toBe("Robin");
    } finally { await server.close(); }
  });

  it.each([
    ["no session", { host: app.host }, 401],
    ["the viewer host", { host: view.host, cookie: browser.cookie }, 404],
  ])("is not read with %s", async (_name, headers, status) => {
    const { server } = await fixture({ name: "Robin" });
    try {
      const response = await server.inject({ method: "GET", url: "/api/me", headers });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain("Robin");
    } finally { await server.close(); }
  });

  it("gives another site's page no CORS permission to read it", async () => {
    const { server } = await fixture({ name: "Robin" });
    try {
      for (const origin of [view.origin, "https://evil.test"]) {
        for (const method of ["GET", "OPTIONS"] as const) {
          const response = await server.inject({ method, url: "/api/me", headers: { ...browser, origin, "access-control-request-method": "PUT" } });
          expect(response.headers["access-control-allow-origin"]).toBeUndefined();
          expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
        }
      }
    } finally { await server.close(); }
  });

  it.each([
    [{ ownerName: "" }],
    [{ ownerName: "Robin\nExample" }],
    [{ ownerName: "R".repeat(81) }],
    [{ ownerName: 7 }],
    [{ ownerName: "Robin", passkeys: 0 }],
    [{}],
  ])("refuses an invalid name: %j", async (payload) => {
    const { server, writes } = await fixture({ name: "Robin" });
    try {
      const response = await server.inject({ method: "PUT", url: "/api/me", headers: browser, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_request");
      expect(writes).toEqual([]);
    } finally { await server.close(); }
  });

  it("is not set on a server with no owner account", async () => {
    const { server } = await fixture(null);
    try {
      const response = await server.inject({ method: "PUT", url: "/api/me", headers: browser, payload: { ownerName: "Robin" } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("not_set_up");
    } finally { await server.close(); }
  });

  it("is not on the agent's MCP listener, even with a run token and the app's host", async () => {
    const db = { query: vi.fn(async () => { throw new Error("The MCP listener must not reach the database for this path"); }) } as unknown as Db;
    const mcp = new McpEndpoint(db, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      () => { throw new Error("unused"); }, {} as never, {} as never, {} as never, pino({ level: "silent" }), () => null);
    const listener = await mcp.listen("127.0.0.1", 0);
    const port = (listener.address() as { port: number }).port;
    const call = (method: string) => new Promise<number>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, method, path: "/api/me", headers: { host: app.host, origin: app.origin, authorization: `Bearer ${"a".repeat(40)}`, "content-type": "application/json" } },
        (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on("error", reject);
      request.end(method === "PUT" ? JSON.stringify({ ownerName: "Mallory" }) : undefined);
    });
    try {
      expect(await call("GET")).toBe(404);
      expect(await call("PUT")).toBe(404);
      expect(db.query).not.toHaveBeenCalled();
    } finally { listener.close(); }
  });
});

describe("the owner's name on servers set up before it could be given", () => {
  it.each([
    ["Owner", null],
    ["Robin", "Robin"],
    ["  E\u0301mile ", "Émile"],
    ["Robin\nExample", null],
    ["", null],
  ])("keeps %j as %j", (stored, migrated) => {
    expect(migratedOwnerName(stored)).toBe(migrated);
  });
});

describe("the setup passkey", () => {
  it("is labelled with the server's host, not a name", async () => {
    const config = { appOrigin: app.origin } as unknown as ControlConfig;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("select hash from setup_tickets")) return { rows: [{ hash: "ticket" }], rowCount: 1 };
        if (sql.startsWith("select webauthn_user_id from owner_account")) return { rows: [], rowCount: 0 };
        if (sql.startsWith("select id, transports from passkeys")) return { rows: [], rowCount: 0 };
        if (sql.startsWith("insert into webauthn_challenges")) return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    } as unknown as Db;
    const { options } = await new Auth(db, config, { append: vi.fn() } as never, () => []).setupOptions("t".repeat(43));
    expect((options as { user: unknown }).user).toMatchObject({ name: "quokkabot.test", displayName: "" });
  });
});
