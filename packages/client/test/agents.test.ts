import { describe, expect, it } from "vitest";
import { AgentSummary } from "@quokkabot/shared";
import { agentNameEdit, withAgent } from "../src/index.js";
import { agentId } from "./fixtures.js";

const office = AgentSummary.parse({
  id: agentId, name: "Office", model: "claude-opus-5-5", effort: "high", cliSignedIn: "yes",
  computer: { state: "stopped", sandboxes: [], lease: { holder: "agent", generation: 1, expiresAt: null }, attendedOpen: false, killedAt: null },
  activeTaskId: null, waitingOnOwner: 0, index: 1, generation: 1, removing: false,
});
const second = AgentSummary.parse({ ...office, id: "66666666-6666-4666-8666-666666666666", name: "Agent 2", index: 2 });

describe("agent names", () => {
  it("saves a trimmed name of 1 to 40 characters", () => {
    expect(agentNameEdit("  Invoices  ", "Office")).toEqual({ kind: "save", name: "Invoices" });
    expect(agentNameEdit("I", "Office")).toEqual({ kind: "save", name: "I" });
    expect(agentNameEdit("x".repeat(40), "Office")).toEqual({ kind: "save", name: "x".repeat(40) });
  });
  it("refuses an empty or a 41-character name with one plain line", () => {
    expect(agentNameEdit("   ", "Office")).toEqual({ kind: "invalid", message: "Type a name." });
    expect(agentNameEdit("x".repeat(41), "Office")).toEqual({ kind: "invalid", message: "Use 40 characters or fewer." });
  });
  it("sends nothing for the current name", () => {
    expect(agentNameEdit(" Office ", "Office")).toEqual({ kind: "unchanged" });
  });
  it("replaces only the renamed agent in the list", () => {
    const list = { agents: [office, second], capacity: { used: 2, total: 3 } };
    const renamed = { ...office, name: "Invoices" };
    expect(withAgent(list, renamed)).toEqual({ agents: [renamed, second], capacity: { used: 2, total: 3 } });
    expect(withAgent(undefined, renamed)).toBeUndefined();
  });
});
