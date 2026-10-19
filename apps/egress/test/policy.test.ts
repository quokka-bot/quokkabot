import { expect, it } from "vitest";
import { AgentEgressPolicy, TaskId } from "@quokkabot/shared";
import { authorizeHost } from "../src/policy.js";

const task = TaskId.parse("00000000-0000-4000-8000-000000000001");
const other = TaskId.parse("00000000-0000-4000-8000-000000000002");
const now = Date.parse("2026-10-17T12:00:00Z");
function policy() {
  return AgentEgressPolicy.parse({
    frozen: false, cli: { allow: ["api.anthropic.com", "*.claude.ai"] },
    browser: { currentTaskId: task, attendedOpen: false, rules: [{ pattern: "*.example.com", attended: false, taskId: null, expiresAt: null }] },
  });
}
it("uses shared wildcard semantics for both policy kinds", () => {
  const p = policy();
  for (const host of ["example.com", "a.example.com", "a.b.example.com"]) expect(authorizeHost(p, "browser", host, now).decision).toBe("allowed");
  for (const host of ["notexample.com", "example.com.evil.test", "claude.ai"]) expect(authorizeHost(p, "browser", host, now).decision).toBe("blocked_domain");
  for (const host of ["api.anthropic.com", "claude.ai", "login.claude.ai"]) expect(authorizeHost(p, "cli", host, now).decision).toBe("allowed");
  expect(authorizeHost(p, "cli", "example.com", now).decision).toBe("blocked_domain");
});
it("requires the matching current task and an unexpired rule", () => {
  const p = policy();
  const rule = p.browser.rules[0]!;
  rule.taskId = task;
  rule.expiresAt = new Date(now + 1000).toISOString();
  expect(authorizeHost(p, "browser", "example.com", now)).toEqual({ decision: "allowed", expiresAt: now + 1000 });
  expect(authorizeHost(p, "browser", "example.com", now + 1000).decision).toBe("blocked_domain");
  p.browser.currentTaskId = other;
  expect(authorizeHost(p, "browser", "example.com", now).decision).toBe("blocked_domain");
  rule.taskId = null;
  expect(authorizeHost(p, "browser", "example.com", now).decision).toBe("allowed");
  expect(authorizeHost(p, "browser", "example.com", now, task).decision).toBe("blocked_domain");
  rule.expiresAt = "invalid date";
  expect(authorizeHost(p, "browser", "example.com", now).decision).toBe("blocked_domain");
});
it("reports attended only when scope and expiry otherwise match", () => {
  const p = policy();
  p.browser.rules[0]!.attended = true;
  expect(authorizeHost(p, "browser", "example.com", now).decision).toBe("blocked_attended");
  p.browser.attendedOpen = true;
  expect(authorizeHost(p, "browser", "example.com", now).decision).toBe("allowed");
  p.browser.attendedOpen = false;
  p.browser.rules[0]!.taskId = other;
  expect(authorizeHost(p, "browser", "example.com", now).decision).toBe("blocked_domain");
  p.browser.rules[0]!.taskId = null;
  p.browser.rules[0]!.expiresAt = new Date(now - 1).toISOString();
  expect(authorizeHost(p, "browser", "example.com", now).decision).toBe("blocked_domain");
});
it("combines alternative grants and frozen dominates both kinds", () => {
  const p = policy();
  p.browser.rules[0]!.attended = true;
  p.browser.rules.push({ pattern: "example.com", attended: false, taskId: task, expiresAt: new Date(now + 2000).toISOString() });
  expect(authorizeHost(p, "browser", "example.com", now).decision).toBe("allowed");
  p.browser.rules.push({ pattern: "example.com", attended: false, taskId: task, expiresAt: new Date(now + 4000).toISOString() });
  expect(authorizeHost(p, "browser", "example.com", now).expiresAt).toBe(now + 4000);
  p.browser.attendedOpen = true;
  expect(authorizeHost(p, "browser", "example.com", now).expiresAt).toBe(null);
  p.frozen = true;
  expect(authorizeHost(p, "browser", "example.com", now).decision).toBe("frozen");
  expect(authorizeHost(p, "cli", "api.anthropic.com", now).decision).toBe("frozen");
  expect(authorizeHost(undefined, "cli", "api.anthropic.com", now).decision).toBe("frozen");
});
