import { beforeEach, expect, it, vi } from "vitest";

// What this phone keeps between launches can be damaged by an interrupted write. Neither a damaged sign-in nor a
// damaged consent file may stop the app from starting.
const disk = vi.hoisted(() => ({ files: new Map<string, string>(), keychain: new Map<string, string>() }));
vi.mock("expo-file-system", () => ({
  Paths: { document: "documents" },
  File: class {
    constructor(private readonly dir: string, private readonly name: string) {}
    get exists() { return disk.files.has(this.name); }
    textSync() { return disk.files.get(this.name)!; }
    create() { disk.files.set(this.name, ""); }
    write(text: string) { disk.files.set(this.name, text); }
  },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => disk.keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { disk.keychain.set(key, value); },
  deleteItemAsync: async (key: string) => { disk.keychain.delete(key); },
}));
vi.mock("react-native", () => ({ StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }, Switch: () => null, Text: () => null, View: () => null }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("../src/session", () => ({ useSignedIn: vi.fn() }));

beforeEach(() => { disk.files.clear(); disk.keychain.clear(); vi.resetModules(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });

it.each(["{", "null", JSON.stringify({ origin: "https://bot.example.com" })])("deletes a damaged saved sign-in and starts signed out: %s", async (stored) => {
  disk.keychain.set("connection", stored);
  const { loadConnection } = await import("../src/connection");
  await expect(loadConnection()).resolves.toBeNull();
  expect(disk.keychain.has("connection")).toBe(false);
});

it("keeps a saved sign-in that reads", async () => {
  const connection = { origin: "https://bot.example.com", viewOrigin: "https://view.example.com", token: "t".repeat(43) };
  disk.keychain.set("connection", JSON.stringify(connection));
  const { loadConnection } = await import("../src/connection");
  await expect(loadConnection()).resolves.toEqual(connection);
});

it.each(["{", "[]", "null", "7"])("treats a damaged consent file as no consent, so the phone asks again: %s", async (stored) => {
  disk.files.set("ai-consent.json", stored);
  const consent = await import("../src/consent");
  expect(consent.hasConsent("https://bot.example.com", "agent")).toBe(false);
  consent.grantConsent("https://bot.example.com", "agent");
  expect(consent.hasConsent("https://bot.example.com", "agent")).toBe(true);
});

it("reads only text values from the consent file", async () => {
  const { DISCLOSURE_VERSION } = await import("../src/consent");
  vi.resetModules();
  disk.files.set("ai-consent.json", JSON.stringify({ "https://bot.example.com|agent": DISCLOSURE_VERSION, "https://bot.example.com|other": 1 }));
  const consent = await import("../src/consent");
  expect(consent.hasConsent("https://bot.example.com", "agent")).toBe(true);
  expect(consent.hasConsent("https://bot.example.com", "other")).toBe(false);
});

it("turns the AI provider permission on in Settings only through the permission screen", async () => {
  const { router } = await import("expo-router");
  const { changeConsent, grantConsent, hasConsent } = await import("../src/consent");
  changeConsent("https://bot.example.com", "agent-id", true);
  expect(router.push).toHaveBeenCalledWith({ pathname: "/consent/[agentId]", params: { agentId: "agent-id" } });
  expect(hasConsent("https://bot.example.com", "agent-id")).toBe(false);
  grantConsent("https://bot.example.com", "agent-id");
  changeConsent("https://bot.example.com", "agent-id", false);
  expect(hasConsent("https://bot.example.com", "agent-id")).toBe(false);
});
