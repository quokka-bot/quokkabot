import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlLease } from "@quokkabot/shared";
import { AgentSlots } from "../src/agents.js";
import { buildServer, type HttpDeps } from "../src/http.js";
import { UpstreamError } from "../src/clients.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const path = `/api/agents/${agentId}/takeover`;
const body = { kind: "password", value: "owner-native-canary", expectedOrigin: "https://login.example.com", submit: false };
const cookieHeaders = { host: "quokkabot.test", origin: "https://quokkabot.test", cookie: "qb_session=cookie_session" };
const token = "phone_session_token_1234567890";
const phoneHeaders = { host: "quokkabot.test", authorization: `Bearer ${token}` };

describe("owner takeover native fields", () => {
  let app: Awaited<ReturnType<typeof buildServer>>["app"];
  let lease: ControlLease;
  let session: ReturnType<typeof vi.fn>;
  let audit: ReturnType<typeof vi.fn>;
  let ownerFill: ReturnType<typeof vi.fn>;
  let ownerFocus: ReturnType<typeof vi.fn>;
  let logs: string[];
  beforeEach(async () => {
    lease = { holder: "owner", generation: 17, expiresAt: null };
    logs = [];
    session = vi.fn().mockImplementation(async (credential: string, kind: string) => credential === "cookie_session" && kind === "cookie" ? { hash: "owner" } : null);
    audit = vi.fn();
    ownerFill = vi.fn().mockResolvedValue({ commandId: "owner_command", status: "ok" });
    ownerFocus = vi.fn().mockResolvedValue({ field: { origin: "https://login.example.com", kind: "password" } });
    const deps = {
      config: { agents: [{ agentId }], appOrigin: "https://quokkabot.test", appHost: "quokkabot.test", viewHost: "view.test", viewOrigin: "https://view.test" },
      auth: { session },
      db: { query: async (sql: string) => {
        if (sql.startsWith("select * from agents")) return { rows: [{ id: agentId, generation: 1, added_at: new Date(), removing_at: null }] };
        throw new Error(`Unexpected SQL: ${sql}`);
      } },
      computer: { lease: async () => lease },
      handles: () => ({ browser: { ownerFocus, ownerFill } }),
      audit: { append: audit },
      log: pino({}, { write: (text) => { logs.push(text); } }),
    } as unknown as HttpDeps;
    deps.slots = new AgentSlots(deps.db, deps.config, deps.audit);
    app = (await buildServer(deps)).app;
  });
  afterEach(async () => { await app.close(); });
  function focus(headers: Record<string, string> = cookieHeaders) { return app.inject({ method: "GET", url: `${path}/focus`, headers }); }
  function fill(headers: Record<string, string> = cookieHeaders, payload: Record<string, unknown> = body) { return app.inject({ method: "POST", url: `${path}/fill`, headers, payload }); }

  it.each(["agent", "paused", "expired"])("refuses %s leases with 409 without contacting the browser", async (state) => {
    lease = state === "expired" ? { ...lease, expiresAt: "2000-01-01T00:00:00Z" } : { ...lease, holder: state as "agent" | "paused" };
    for (const response of [await focus(), await fill()]) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("no_takeover");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(ownerFocus).not.toHaveBeenCalled();
    expect(ownerFill).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("requires a signed-in session for both routes and keeps their errors out of caches", async () => {
    session.mockResolvedValue(null);
    for (const response of [await focus(), await fill()]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(ownerFill).not.toHaveBeenCalled();
    expect(ownerFocus).not.toHaveBeenCalled();
  });

  it("passes the owner lease generation, audits only kind and hostname, and never logs the native value", async () => {
    const metadata = await focus();
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual({ field: { origin: body.expectedOrigin, kind: body.kind } });
    expect(ownerFocus).toHaveBeenCalledWith(17);
    const response = await fill();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(session).toHaveBeenCalledWith("cookie_session", "cookie");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(ownerFill).toHaveBeenCalledWith({ ...body, commandId: expect.stringMatching(/^[a-z0-9-]{36}$/), leaseGeneration: 17 });
    expect(audit).toHaveBeenCalledWith(agentId, "owner", "owner.filled_field", { kind: "password", site: "login.example.com" });
    expect(logs.join("") + JSON.stringify(audit.mock.calls) + response.body + metadata.body).not.toContain(body.value);
  });

  it("accepts the phone bearer token without Origin and ignores cookies", async () => {
    session.mockImplementation(async (credential: string, kind: string) => credential === token && kind === "bearer" ? { hash: "phone" } : null);
    const headers = { ...phoneHeaders, cookie: cookieHeaders.cookie };
    expect((await focus(headers)).statusCode).toBe(200);
    expect((await fill(headers)).statusCode).toBe(200);
    expect(session.mock.calls.every((args) => args[0] === token && args[1] === "bearer")).toBe(true);
    expect(ownerFill).toHaveBeenCalledWith(expect.objectContaining({ leaseGeneration: 17 }));
    expect((await fill({ ...cookieHeaders, authorization: "Bearer invalid" })).statusCode).toBe(401);
  });

  it("enforces the existing cookie Origin check", async () => {
    const response = await fill({ ...cookieHeaders, origin: "https://attacker.example" });
    expect(response.statusCode).toBe(403);
    expect(ownerFill).not.toHaveBeenCalled();
  });

  it.each([
    ["blocked", "wrong field kind", 409, "wrong_field", "Tap the password or code field on the computer first."],
    ["blocked", "wrong site", 409, "wrong_site", "The page changed. Check the site and try again."],
    ["blocked", "no takeover", 409, "no_takeover", "Take over the computer first."],
    ["outcome_unknown", body.value, 502, "owner_fill_failed", "Could not fill the field. Check the computer before trying again."],
    ["failed", body.value, 502, "owner_fill_failed", "Could not fill the field. Check the computer before trying again."],
  ])("maps %s %s to a fixed owner error", async (status, message, expectedStatus, code, expectedMessage) => {
    ownerFill.mockResolvedValue({ commandId: "owner_command", status, message });
    const response = await fill();
    expect(response.statusCode).toBe(expectedStatus);
    expect(response.json()).toEqual({ error: { code, message: expectedMessage } });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(audit).not.toHaveBeenCalled();
    expect(response.body + logs.join("")).not.toContain(body.value);
  });

  it("redacts transport exceptions, and reports lost takeovers from focus", async () => {
    ownerFill.mockRejectedValue(new Error(body.value));
    ownerFocus.mockRejectedValue(new Error(body.value));
    for (const response of [await fill(), await focus()]) {
      expect(response.statusCode).toBe(502);
      expect(response.body + logs.join("")).not.toContain(body.value);
    }
    ownerFocus.mockRejectedValue(new UpstreamError(body.value, 409, ""));
    const response = await focus();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("no_takeover");
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([{}, { ...body, value: "" }, { ...body, value: "x".repeat(501) }, { ...body, kind: "username" }, { ...body, leaseGeneration: 18 }, { ...body, expectedOrigin: "https://example.com/path" }, { ...body, expectedOrigin: body.value }])("validates fill bodies before forwarding %j", async (payload) => {
    const response = await fill(cookieHeaders, payload);
    expect(response.statusCode).toBe(400);
    expect(ownerFill).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(response.body + logs.join("")).not.toContain(body.value);
  });

  it.each(["focus", "fill"])("limits %s to 30 requests per minute", async (route) => {
    for (let i = 0; i < 30; i++) expect((await (route === "focus" ? focus() : fill())).statusCode).toBe(200);
    const response = await (route === "focus" ? focus() : fill());
    expect(response.statusCode).toBe(429);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
