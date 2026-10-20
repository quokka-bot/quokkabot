import { expect, it, vi } from "vitest";
import { createApi } from "../src/api";

// A rename from the phone sends only the name, with the agent's generation, so a model or effort changed in another app
// stays as it is.
const origin = "https://bot.example.com";
const token = "t".repeat(43);
const summary = {
  id: "11111111-1111-4111-8111-111111111111", name: "Office", model: "claude-opus-5-5", effort: "high", cliSignedIn: "yes",
  computer: { state: "stopped", sandboxes: [], lease: { holder: "agent", generation: 1, expiresAt: null }, attendedOpen: false, killedAt: null },
  activeTaskId: null, waitingOnOwner: 0, generation: 3, aiConsent: null,
};

it("renames with only the trimmed name and the agent's generation", async () => {
  const responses: unknown[] = [{ agents: [summary], capacity: { used: 1, total: 1 } }, { ...summary, name: "Invoices" }];
  const fetchImpl = vi.fn(async () => ({ status: 200, ok: true, json: async () => responses.shift() }));
  const api = createApi(fetchImpl, origin, token, () => undefined);
  await api.agents();
  expect((await api.rename(summary.id, "  Invoices  ")).name).toBe("Invoices");
  expect(fetchImpl).toHaveBeenLastCalledWith(`${origin}/api/agents/${summary.id}/settings`, expect.objectContaining({
    method: "PUT", body: JSON.stringify({ name: "Invoices" }), headers: expect.objectContaining({ Authorization: `Bearer ${token}`, "X-Quokkabot-Agent-Generation": "3" }),
  }));
});

it("refuses an empty or a 41-character name before sending anything", async () => {
  const fetchImpl = vi.fn(async () => ({ status: 200, ok: true, json: async () => summary }));
  const api = createApi(fetchImpl, origin, token, () => undefined);
  await expect(api.rename(summary.id, "   ")).rejects.toThrow();
  await expect(api.rename(summary.id, "x".repeat(41))).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("shows the server's reason when it refuses the rename", async () => {
  const fetchImpl = vi.fn(async () => ({ status: 409, ok: false, json: async () => ({ error: { code: "agent_removing", message: "This agent is being removed." } }) }));
  const api = createApi(fetchImpl, origin, token, () => undefined);
  await expect(api.rename(summary.id, "Invoices")).rejects.toThrow("This agent is being removed.");
});
