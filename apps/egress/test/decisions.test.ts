import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentId } from "@quokkabot/shared";
import { DecisionStore } from "../src/decisions.js";

it("keeps one epoch with its sequence and generates a different epoch in a new process", async () => {
  const store = new DecisionStore();
  const epoch = store.epoch;
  expect(epoch).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await store.wait(0, 0, new AbortController().signal);
  expect(store.epoch).toBe(epoch);
  expect(new DecisionStore().epoch).not.toBe(epoch);
  // This module has only erasable types and Node built-ins at runtime, so Node 24 can load it directly.
  const moduleUrl = new URL("../src/decisions.ts", import.meta.url).href;
  const source = `import { DecisionStore } from ${JSON.stringify(moduleUrl)}; process.stdout.write(new DecisionStore().epoch);`;
  const child = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", source]);
  expect(child.stdout).toMatch(/^[0-9a-f-]{36}$/);
  expect(child.stdout).not.toBe(epoch);
});

it("keeps exactly the most recent 10,000 decisions, ordered and independently readable", async () => {
  const store = new DecisionStore();
  const event = {
    at: "2026-10-17T12:00:00.000Z", agentId: AgentId.parse("00000000-0000-4000-8000-000000000001"),
    listener: "browser" as const, host: "example.com", port: 443, method: "CONNECT", decision: "allowed" as const, policyRevision: 1,
  };
  for (let i = 0; i < 10_005; i++) store.append(event);
  const retained = store.after(0);
  expect(retained).toHaveLength(10_000);
  expect(retained[0]!.seq).toBe(6);
  expect(retained.at(-1)!.seq).toBe(10_005);
  expect(store.after(10_004).map((entry) => entry.seq)).toEqual([10_005]);
  expect(store.after(10_005)).toEqual([]);
  const controller = new AbortController();
  const pending = store.wait(10_006, 1000, controller.signal);
  store.append(event); // A future cursor must keep waiting until a greater sequence appears.
  store.append(event);
  expect((await pending).map((entry) => entry.seq)).toEqual([10_007]);
  const cancelled = store.wait(10_007, 1000, controller.signal);
  controller.abort();
  expect(await cancelled).toEqual([]);
});
