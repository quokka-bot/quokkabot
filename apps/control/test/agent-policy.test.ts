import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { EgressDecisionEvent } from "@quokkabot/shared";
import type { AgentSlots } from "../src/agents.js";
import type { Db } from "../src/db.js";
import { PolicyService } from "../src/policy.js";

const id = "11111111-1111-4111-8111-111111111111";
const event = EgressDecisionEvent.parse({ agentId: id, seq: 1, at: "2026-10-17T12:00:01.000Z", listener: "browser", host: "vendor.example.com", port: 443, method: "CONNECT", decision: "blocked_domain", policyRevision: 1 });

describe("policy history across slot reuse", () => {
  it.each(["free", "removing", "previous occupant", "added"])("records a blocked host only for the current added agent: %s", async state => {
    const query = vi.fn(async () => ({ rows: [] }));
    const slots = { knownIds: new Set(state === "free" ? [] : [id]), require: async () => ({
      added_at: new Date(state === "previous occupant" ? "2026-10-17T12:00:02.000Z" : "2026-10-17T12:00:00.000Z"), removing_at: state === "removing" ? new Date() : null,
    }) } as unknown as AgentSlots;
    const policy = new PolicyService({ query } as unknown as Db, {} as never, {} as never, pino({ level: "silent" }), () => [id], slots);
    await (policy as unknown as { recordDecision: (event: EgressDecisionEvent) => Promise<void> }).recordDecision(event);
    expect(query.mock.calls.length > 0).toBe(state === "added");
    expect(policy.blockedSince(id, Date.parse(event.at))).toEqual(state === "added" ? [event.host] : []);
    policy.forgetAgent(id);
    expect(policy.blockedSince(id, 0)).toEqual([]);
  });
  it("still pushes infrastructure policy for every configured slot", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const require = vi.fn();
    const query = async (sql: string) => ({ rows: sql.includes("select killed_at") ? [{ killed_at: null, attended_open: false }] : sql.includes("returning (value)") ? [{ value: 1 }] : [] });
    const policy = new PolicyService({ query } as unknown as Db, {} as never, {} as never, pino({ level: "silent" }), () => [id, other], { knownIds: new Set([id]), require } as unknown as AgentSlots);
    expect(Object.keys((await policy.snapshot()).agents)).toEqual([id, other]);
    expect(require).not.toHaveBeenCalled();
  });
});
