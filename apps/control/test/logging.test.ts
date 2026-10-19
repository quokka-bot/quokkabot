import pino from "pino";
import { describe, expect, it } from "vitest";
import { buildServer, type HttpDeps } from "../src/http.js";
import { redactRequestUrl, serializeRequest } from "../src/logging.js";

describe("request logging", () => {
  it.each([false, true])("redacts callback query values with parent serializers: %s", async (parentSerializer) => {
    const output: string[] = [];
    const log = pino(parentSerializer ? { serializers: { req: serializeRequest } } : {}, { write: (text) => { output.push(text); } });
    const callback = async (code: string, state: string) => {
      expect(code).toBe("distinctive-code-secret");
      expect(state).toBe("distinctive-state-secret");
      return { agentId: "test-agent", account: "owner@example.test", id: "test-connector" };
    };
    const { app } = await buildServer({
      config: { agents: [], appOrigin: "https://quokkabot.test", appHost: "quokkabot.test", viewHost: "view.test", viewOrigin: "https://view.test" },
      connectors: { callback }, tasks: { connectorConnected: async () => undefined }, log,
    } as unknown as HttpDeps);
    try {
      const response = await app.inject({ url: "/api/connect/google/callback?code=distinctive-code-secret&state=distinctive-state-secret&scope=distinctive-scope-secret", headers: { host: "quokkabot.test" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Gmail connected");
      const logs = output.join("");
      for (const secret of ["distinctive-code-secret", "distinctive-state-secret", "distinctive-scope-secret"]) expect(logs).not.toContain(secret);
      expect(output.map((line) => JSON.parse(line) as { req?: { url: string } }).find((entry) => entry.req)?.req?.url)
        .toBe("/api/connect/google/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&scope=%5Bredacted%5D");
    } finally {
      await app.close();
    }
  });

  it("redacts sensitive query names on every route, including encoded names and duplicates", () => {
    expect(redactRequestUrl("/api/example?code=secret&state=secret&token=secret&%74oken=secret&CODE=secret&safe=visible"))
      .toBe("/api/example?code=%5Bredacted%5D&state=%5Bredacted%5D&token=%5Bredacted%5D&token=%5Bredacted%5D&CODE=%5Bredacted%5D&safe=visible");
    expect(redactRequestUrl("/api/example")).toBe("/api/example");
  });
});

it("redacts the one-time view ticket from the viewer's URL", () => {
  expect(redactRequestUrl("/agents/6f1c1d2e-8f4b-4c55-9a59-0d7a7f6f3a10/?ticket=one-time-capability&Ticket=again"))
    .toBe("/agents/6f1c1d2e-8f4b-4c55-9a59-0d7a7f6f3a10/?ticket=%5Bredacted%5D&Ticket=%5Bredacted%5D");
});

it("redacts uploaded image names from request URLs", () => {
  expect(redactRequestUrl("/api/agents/id/attachments?name=private-invoice.png")).toBe("/api/agents/id/attachments?name=%5Bredacted%5D");
});
