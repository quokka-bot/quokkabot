import { describe, expect, it } from "vitest";
import { AgentSummary, ClaudeSignInCode, ClaudeSignInStart, ClaudeSignInStatus, claudeSignInError } from "../src/index.js";

describe("Claude sign-in contracts", () => {
  it("accepts boundary code lengths and refuses extra fields", () => {
    for (const size of [8, 256]) expect(ClaudeSignInCode.safeParse({ code: "a".repeat(size) + "#" + "b".repeat(size) }).success).toBe(true);
    expect(ClaudeSignInCode.safeParse({ code: "abcdefgh#abcdefgh", token: "secret" }).success).toBe(false);
  });

  it("strips private CLI status fields and fills absent signed-out metadata", () => {
    expect(ClaudeSignInStatus.parse({ loggedIn: true, email: "owner@example.test", subscriptionType: "max", authMethod: "claude.ai", token: "secret" }))
      .toEqual({ loggedIn: true, email: "owner@example.test", subscriptionType: "max" });
    expect(ClaudeSignInStatus.parse({ loggedIn: false })).toEqual({ loggedIn: false, email: null, subscriptionType: null });
  });

  it("parses older agent summaries with nullable account fields", () => {
    const agent = AgentSummary.parse({ id: "11111111-1111-4111-8111-111111111111", name: "Office", model: "claude-opus-4-6", effort: "high", cliSignedIn: "no", computer: { state: "stopped", sandboxes: [], lease: { holder: "paused", generation: 1, expiresAt: null }, attendedOpen: false, killedAt: null }, activeTaskId: null, waitingOnOwner: 0 });
    expect(agent.cliAccount).toBeNull();
    expect(agent.cliPlan).toBeNull();
  });

  it("refuses an authorization link from another origin", () => {
    expect(ClaudeSignInStart.safeParse({ signInId: "11111111-1111-4111-8111-111111111111", url: "https://evil.test/oauth/authorize" }).success).toBe(false);
  });

  it("removes controls and ANSI codes before redacting and truncating failure lines", () => {
    expect(claudeSignInError("  Login failed: abcdefgh\x1b[31m#abcdefgh\u0007  ")).toBe("Login failed: [redacted]");
    expect(claudeSignInError("Login failed: " + "x".repeat(500))).toHaveLength(200);
  });
});
