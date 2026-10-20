import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlLease } from "@quokkabot/shared";
import { AgentSlots } from "../src/agents.js";
import { buildServer, type HttpDeps } from "../src/http.js";
import { UpstreamError } from "../src/clients.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const url = `/api/agents/${agentId}/takeover/screen`;
const phone = { width: 504, height: 846 };
const cookieHeaders = { host: "quokkabot.test", origin: "https://quokkabot.test", cookie: "qb_session=cookie_session" };
const token = "phone_session_token_1234567890";
const phoneHeaders = { host: "quokkabot.test", authorization: `Bearer ${token}` };

describe("fitting the computer's screen to the owner's phone", () => {
  let app: Awaited<ReturnType<typeof buildServer>>["app"];
  let lease: ControlLease;
  let session: ReturnType<typeof vi.fn>;
  let audit: ReturnType<typeof vi.fn>;
  let setScreen: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    lease = { holder: "owner", generation: 17, expiresAt: null };
    session = vi.fn().mockImplementation(async (credential: string, kind: string) =>
      (credential === "cookie_session" && kind === "cookie") || (credential === token && kind === "bearer") ? { hash: "owner" } : null);
    audit = vi.fn();
    setScreen = vi.fn().mockImplementation(async (request: { width: number; height: number }) => ({ width: request.width, height: request.height }));
    const deps = {
      config: { agents: [{ agentId }], appOrigin: "https://quokkabot.test", appHost: "quokkabot.test", viewHost: "view.test", viewOrigin: "https://view.test" },
      auth: { session },
      db: { query: async (sql: string) => {
        if (sql.startsWith("select * from agents")) return { rows: [{ id: agentId, generation: 1, added_at: new Date(), removing_at: null }] };
        throw new Error(`Unexpected SQL: ${sql}`);
      } },
      computer: { lease: async () => lease },
      handles: () => ({ browser: { setScreen } }),
      audit: { append: audit },
      log: pino({ level: "silent" }),
    } as unknown as HttpDeps;
    deps.slots = new AgentSlots(deps.db, deps.config, deps.audit);
    app = (await buildServer(deps)).app;
  });
  afterEach(async () => { await app.close(); });
  const put = (headers: Record<string, string> = phoneHeaders, payload: unknown = phone) => app.inject({ method: "PUT", url, headers, payload: payload as Record<string, unknown> });

  it("passes the size with the owner's lease generation and audits it", async () => {
    const response = await put();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(phone);
    expect(setScreen).toHaveBeenCalledWith({ ...phone, leaseGeneration: 17 });
    expect(audit).toHaveBeenCalledWith(agentId, "owner", "takeover.screen", { ...phone, generation: 17 });
    expect((await put(cookieHeaders)).statusCode).toBe(200);
  });

  it.each(["agent", "paused", "expired"])("refuses a %s lease without contacting the browser", async (state) => {
    lease = state === "expired" ? { ...lease, expiresAt: "2000-01-01T00:00:00Z" } : { ...lease, holder: state as "agent" | "paused" };
    const response = await put();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("no_takeover");
    expect(setScreen).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("is for signed-in owners only: the agent's CLI token and a cross-site cookie request are refused", async () => {
    expect((await put({ host: "quokkabot.test", authorization: "Bearer agent_cli_token_1234567890" })).statusCode).toBe(401);
    expect((await put({ host: "quokkabot.test" })).statusCode).toBe(403);
    expect((await put({ ...cookieHeaders, origin: "https://attacker.example" })).statusCode).toBe(403);
    expect((await put({ ...phoneHeaders, host: "view.test" })).statusCode).toBe(404);
    expect(setScreen).not.toHaveBeenCalled();
  });

  it.each([{}, { width: 392, height: 660 }, { width: 505, height: 846 }, { width: 3840, height: 660 }, { width: 504, height: 100 }, { ...phone, leaseGeneration: 99 }, { ...phone, dpi: 288 }])(
    "validates %j before forwarding", async (payload) => {
      expect((await put(phoneHeaders, payload)).statusCode).toBe(400);
      expect(setScreen).not.toHaveBeenCalled();
    });

  it("maps a lease the browser refused to no_takeover and other failures to a fixed error", async () => {
    setScreen.mockRejectedValue(new UpstreamError("PUT /v1/screen", 409, "{\"message\":\"no takeover\"}"));
    expect((await put()).json().error.code).toBe("no_takeover");
    setScreen.mockRejectedValue(new Error("screen resize failed"));
    const response = await put();
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: { code: "screen_failed", message: "Could not fit the screen to this phone. Refresh the view." } });
    expect(audit).not.toHaveBeenCalled();
  });
});
