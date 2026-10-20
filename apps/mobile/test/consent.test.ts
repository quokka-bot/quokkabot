import { beforeEach, expect, it, vi } from "vitest";
import { AI_PROVIDERS, type AgentSummary, type AiConsentView } from "@quokkabot/shared";

// The phone follows the server's record of the AI provider permission; the file earlier builds kept is deleted.
const disk = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("expo-file-system", () => ({
  Paths: { document: "documents" },
  File: class {
    constructor(private readonly dir: string, private readonly name: string) {}
    get exists() { return disk.files.has(this.name); }
    delete() { disk.files.delete(this.name); }
  },
}));
vi.mock("react-native", () => ({ StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }, Switch: () => null, Text: () => null, View: () => null }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("../src/session", () => ({ useSignedIn: vi.fn() }));
vi.mock("../src/ui/kit", () => ({ ErrorLine: () => null }));
vi.mock("../src/ui/theme", () => ({ colors: {} }));

const origin = "https://bot.example.com";
const view = (state: AiConsentView["state"], disclosureVersion: string = AI_PROVIDERS.anthropic.disclosureVersion): AiConsentView => ({
  provider: "anthropic", disclosureVersion, state, required: false, allowed: state !== "withdrawn", changedAt: null, changedBy: null,
});
const agent = (aiConsent: AiConsentView | null) => ({ id: "agent-id", generation: 3, aiConsent }) as unknown as AgentSummary;

beforeEach(() => { disk.files.clear(); vi.resetModules(); vi.clearAllMocks(); });

it("deletes the consent file earlier builds kept on the phone", async () => {
  disk.files.set("ai-consent.json", JSON.stringify({ [`${origin}|agent-id`]: "2026-10-19" }));
  await import("../src/consent");
  expect(disk.files.has("ai-consent.json")).toBe(false);
});

it("sends only after an allow under the notice this build shows, whatever the server would send without one", async () => {
  const store = await import("../src/consent-store");
  expect(store.hasConsent(origin, "agent-id")).toBe(false);
  store.rememberAgentConsent(origin, agent(view("not_asked")));
  expect(store.hasConsent(origin, "agent-id")).toBe(false);
  store.rememberAgentConsent(origin, agent(view("granted", "2000-01-01")));
  expect(store.hasConsent(origin, "agent-id")).toBe(false);
  store.rememberAgentConsent(origin, agent(view("granted")));
  expect(store.hasConsent(origin, "agent-id")).toBe(true);
  expect(store.hasConsent("https://other.example.com", "agent-id")).toBe(false);
  store.rememberAgentConsent(origin, agent(null));
  expect(store.hasConsent(origin, "agent-id")).toBe(false);
});

it("asks again when the server refuses a send that another app's withdrawal stopped", async () => {
  const { router } = await import("expo-router");
  const { ApiFailure } = await import("../src/api");
  const store = await import("../src/consent-store");
  const { consentRefused } = await import("../src/consent");
  store.rememberAgentConsent(origin, agent(view("granted")));
  expect(consentRefused(origin, "agent-id", new ApiFailure("Busy", 409, "task_active"))).toBe(false);
  expect(store.hasConsent(origin, "agent-id")).toBe(true);
  expect(consentRefused(origin, "agent-id", new ApiFailure("Sending to Anthropic is off for this agent. Turn it on to send.", 403, "ai_consent_required"))).toBe(true);
  expect(store.hasConsent(origin, "agent-id")).toBe(false);
  expect(router.push).toHaveBeenCalledWith({ pathname: "/consent/[agentId]", params: { agentId: "agent-id" } });
});

it("turns the permission on in Settings only through the permission screen, and off on the server at once", async () => {
  const { router } = await import("expo-router");
  const { changeConsent } = await import("../src/consent");
  const api = { setAiConsent: vi.fn(async () => view("withdrawn")) };
  await changeConsent(api, "agent-id", true);
  expect(router.push).toHaveBeenCalledWith({ pathname: "/consent/[agentId]", params: { agentId: "agent-id" } });
  expect(api.setAiConsent).not.toHaveBeenCalled();
  await changeConsent(api, "agent-id", false);
  expect(api.setAiConsent).toHaveBeenCalledExactlyOnceWith("agent-id", { allow: false, provider: "anthropic" });
});

it("reads the permission from every agent the server sends, and from the answer to a change", async () => {
  const { createApi } = await import("../src/api");
  const store = await import("../src/consent-store");
  const responses: unknown[] = [];
  const fetchImpl = vi.fn(async () => ({ status: 200, ok: true, json: async () => responses.shift() }));
  const api = createApi(fetchImpl, origin, "t".repeat(43), () => undefined);
  const summary = {
    id: "11111111-1111-4111-8111-111111111111", name: "Office", model: "claude-opus-5-5", effort: "high", cliSignedIn: "yes",
    computer: { state: "stopped", sandboxes: [], lease: { holder: "agent", generation: 1, expiresAt: null }, attendedOpen: false, killedAt: null },
    activeTaskId: null, waitingOnOwner: 0, generation: 3, aiConsent: view("granted"),
  };
  responses.push({ agents: [summary], capacity: { used: 1, total: 1 } });
  await api.agents();
  expect(store.hasConsent(origin, summary.id)).toBe(true);
  responses.push(view("withdrawn"));
  await api.setAiConsent(summary.id, { allow: false, provider: "anthropic" });
  expect(store.hasConsent(origin, summary.id)).toBe(false);
  expect(fetchImpl).toHaveBeenLastCalledWith(`${origin}/api/agents/${summary.id}/ai-consent`, expect.objectContaining({
    method: "PUT", body: JSON.stringify({ allow: false, provider: "anthropic" }), headers: expect.objectContaining({ "X-Quokkabot-Agent-Generation": "3" }),
  }));
});
