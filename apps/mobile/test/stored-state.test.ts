import { beforeEach, expect, it, vi } from "vitest";

// What this phone keeps between launches can be damaged by an interrupted write. A damaged sign-in may not stop the
// app from starting.
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

beforeEach(() => { disk.files.clear(); disk.keychain.clear(); vi.resetModules(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });

it.each(["{", "null", JSON.stringify({ origin: "https://bot.example.com" })])("deletes a damaged saved sign-in and starts signed out: %s", async (stored) => {
  disk.keychain.set("connection", stored);
  const { loadConnection } = await import("../src/connection");
  await expect(loadConnection()).resolves.toBeNull();
  expect(disk.keychain.has("connection")).toBe(false);
});

it("tells a request's sign-in from a newer one, so a late 401 cannot sign out the next session", async () => {
  const { sameConnection } = await import("../src/connection");
  const first = { origin: "https://bot.example.com", viewOrigin: "https://view.example.com", token: "a".repeat(43) };
  expect(sameConnection(first, first)).toBe(true);
  expect(sameConnection({ ...first }, first)).toBe(true);
  expect(sameConnection({ ...first, token: "b".repeat(43) }, first)).toBe(false);
  expect(sameConnection({ ...first, origin: "https://other.example.com" }, first)).toBe(false);
  expect(sameConnection(null, first)).toBe(false);
  expect(sameConnection(undefined, first)).toBe(false);
});

it("keeps a saved sign-in that reads", async () => {
  const connection = { origin: "https://bot.example.com", viewOrigin: "https://view.example.com", token: "t".repeat(43) };
  disk.keychain.set("connection", JSON.stringify(connection));
  const { loadConnection } = await import("../src/connection");
  await expect(loadConnection()).resolves.toEqual(connection);
});
