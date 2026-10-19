import { describe, expect, it } from "vitest";
import { AgentSummary } from "../src/api.js";

const oldSummary = {
  id: "11111111-1111-4111-8111-111111111111", name: "Office", model: "claude-opus-4-6", effort: "high", cliSignedIn: "no",
  computer: { state: "stopped", sandboxes: [], lease: { holder: "paused", generation: 1, expiresAt: null }, attendedOpen: false, killedAt: null },
  activeTaskId: null, waitingOnOwner: 0,
};
describe("agent occupant generation", () => {
  it("reads old payloads as generation 1 and preserves the current generation", () => {
    expect(AgentSummary.parse(oldSummary).generation).toBe(1);
    expect(AgentSummary.parse({ ...oldSummary, generation: 4 }).generation).toBe(4);
  });
  it.each([null, 0, -1, 1.5, "2"])("rejects invalid generations: %s", generation => {
    expect(AgentSummary.safeParse({ ...oldSummary, generation }).success).toBe(false);
  });
});
