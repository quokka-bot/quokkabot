import { hostMatchesPattern } from "@quokkabot/shared";
import type { AgentEgressPolicy, EgressDecision, ListenerKind, TaskId } from "@quokkabot/shared";

export interface Authorization {
  decision: EgressDecision;
  // Latest expiry across alternative grants; null means an unexpiring grant exists.
  expiresAt: number | null;
}

export function authorizeHost(
  policy: AgentEgressPolicy | undefined,
  kind: ListenerKind,
  host: string,
  now: number,
  openedTaskId?: TaskId | null,
): Authorization {
  const deny = (decision: EgressDecision): Authorization => ({ decision, expiresAt: null });
  if (policy === undefined || policy.frozen) return deny("frozen");
  if (kind === "cli") {
    return deny(policy.cli.allow.some((pattern) => hostMatchesPattern(host, pattern)) ? "allowed" : "blocked_domain");
  }
  // Do not transfer an old browser connection into a new task, even if it has the same domain grant.
  if (openedTaskId !== undefined && openedTaskId !== policy.browser.currentTaskId) return deny("blocked_domain");
  let attendedOnly = false;
  let allowed = false;
  let unexpiring = false;
  let latestExpiry = 0;
  for (const rule of policy.browser.rules) {
    if (!hostMatchesPattern(host, rule.pattern)) continue;
    if (rule.taskId !== null && rule.taskId !== policy.browser.currentTaskId) continue;
    const expiry = rule.expiresAt === null ? null : Date.parse(rule.expiresAt);
    if (expiry !== null && (!Number.isFinite(expiry) || expiry <= now)) continue;
    if (rule.attended && !policy.browser.attendedOpen) {
      attendedOnly = true;
      continue;
    }
    allowed = true;
    if (expiry === null) unexpiring = true;
    else latestExpiry = Math.max(latestExpiry, expiry);
  }
  if (!allowed) return deny(attendedOnly ? "blocked_attended" : "blocked_domain");
  return { decision: "allowed", expiresAt: unexpiring ? null : latestExpiry };
}
