import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, type HttpDeps } from "../src/http.js";
import { AgentSlots } from "../src/agents.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const host = "quokkabot.test";

// The phone sign-in routes' own rules, on the HTTP layer with the services faked: they need no Origin, read no
// cookies, refuse a foreign Origin, and are never cached. The flows themselves run against PostgreSQL in
// integration.test.ts.
describe("phone sign-in routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>>["app"] | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  async function server(appleAppIds: string[] = []) {
    const session = vi.fn(async () => ({ hash: "owner", freshUntil: null, client: "browser" }));
    const redeem = vi.fn(async () => "t".repeat(43));
    const signinOptions = vi.fn(async () => ({ challengeId: "33333333-3333-4333-8333-333333333333", options: { challenge: "c" } }));
    const deps = {
      config: { agents: [{ agentId }], appOrigin: `https://${host}`, appHost: host, viewHost: "view.test", viewOrigin: "https://view.test", appleAppIds, secrets: { sessionSecret: Buffer.from("s") } },
      auth: { session, signinOptions },
      pairingCodes: { redeem },
      desktopLinks: {},
      db: { query: async (sql: string) => { throw new Error(`Unexpected SQL: ${sql}`); } },
      audit: { append: vi.fn() },
      log: pino({ level: "silent" }),
    } as unknown as HttpDeps;
    deps.slots = new AgentSlots(deps.db, deps.config, deps.audit);
    app = (await buildServer(deps)).app;
    return { app, session, redeem, signinOptions };
  }

  it("signs in with a code without an Origin, reads no cookie and is never cached", async () => {
    const { app, session, redeem } = await server();
    const response = await app.inject({ method: "POST", url: "/api/phone/code", headers: { host, cookie: "qb_session=browser-token; qb_kill=1.x" }, payload: { code: "abcd efgh jkmn", deviceName: "Owner's iPhone" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ token: "t".repeat(43) });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(redeem).toHaveBeenCalledWith("ABCDEFGHJKMN", "Owner's iPhone");
    expect(session).not.toHaveBeenCalled();
  });

  it("refuses a foreign Origin on the phone sign-in routes, and a missing Origin elsewhere", async () => {
    const { app, signinOptions } = await server();
    for (const url of ["/api/phone/passkey/options", "/api/phone/code", "/api/phone/link/start", "/api/phone/link/poll"]) {
      const response = await app.inject({ method: "POST", url, headers: { host, origin: "https://evil.example" }, payload: {} });
      expect(response.statusCode).toBe(403);
    }
    expect(signinOptions).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: "/api/phone/passkey/options", headers: { host }, payload: {} })).statusCode).toBe(200);
    // A browser sign-in route still needs the app's own Origin.
    expect((await app.inject({ method: "POST", url: "/api/auth/options", headers: { host }, payload: {} })).statusCode).toBe(403);
  });

  it("rejects malformed codes before any lookup", async () => {
    const { app, redeem } = await server();
    for (const code of ["ABCD-EFGH-JKM", "ABCD-EFGH-JKMO", "ABCD-EFGH-JKM1", "ABCD-EFGH-JKMN-P"]) {
      expect((await app.inject({ method: "POST", url: "/api/phone/code", headers: { host }, payload: { code, deviceName: "iPhone" } })).statusCode).toBe(400);
    }
    expect(redeem).not.toHaveBeenCalled();
  });

  it("serves the passkey association only when app ids are configured", async () => {
    expect((await (await server()).app.inject({ method: "GET", url: "/.well-known/apple-app-site-association", headers: { host } })).statusCode).toBe(404);
    await app?.close();
    const configured = await server(["ABCDE12345.com.example.quokkabot"]);
    const response = await configured.app.inject({ method: "GET", url: "/.well-known/apple-app-site-association", headers: { host } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ webcredentials: { apps: ["ABCDE12345.com.example.quokkabot"] } });
  });
});
