import { z } from "zod";
import { AgentId, DomainPattern, TaskId } from "./primitives.js";

// The egress proxy listens once per sandbox network. The listener a connection arrives on decides whose policy
// applies; nothing in the request (headers, proxy credentials) can choose a policy.
export const ListenerKind = z.enum(["cli", "browser"]);
export type ListenerKind = z.infer<typeof ListenerKind>;

export const EgressListener = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,40}$/),
  address: z.ipv4(),
  port: z.number().int().min(1).max(65535),
  agentId: AgentId,
  kind: ListenerKind,
});
export type EgressListener = z.infer<typeof EgressListener>;

// Static configuration file read at start.
export const EgressConfig = z.object({
  listeners: z.array(EgressListener).min(1),
  control: z.object({
    address: z.ipv4(),
    port: z.number().int().min(1).max(65535),
    // Path to a file holding the bearer token the control plane uses.
    tokenFile: z.string(),
  }),
  // The host's own public addresses: always refused, like private ranges.
  hostAddresses: z.array(z.union([z.ipv4(), z.ipv6()])).default([]),
  // Upstream DNS servers used by the proxy itself.
  resolvers: z.array(z.union([z.ipv4(), z.ipv6()])).min(1),
  connectTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  idleTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
});
export type EgressConfig = z.infer<typeof EgressConfig>;

export const BrowserDomainRule = z.object({
  pattern: DomainPattern,
  // Reachable only while the owner has an attended session open (government portals, banks, anything that can
  // submit or pay).
  attended: z.boolean(),
  // Task-scoped grants end with the task.
  taskId: TaskId.nullable(),
  expiresAt: z.string().nullable(),
});
export type BrowserDomainRule = z.infer<typeof BrowserDomainRule>;

export const AgentEgressPolicy = z.object({
  // Kill switch: refuse everything and close every open tunnel.
  frozen: z.boolean(),
  cli: z.object({ allow: z.array(DomainPattern) }),
  browser: z.object({
    rules: z.array(BrowserDomainRule),
    attendedOpen: z.boolean(),
    currentTaskId: TaskId.nullable(),
  }),
});
export type AgentEgressPolicy = z.infer<typeof AgentEgressPolicy>;

// Pushed by the control plane with PUT /v1/policy. Revisions only go up; an older revision is refused.
export const EgressPolicySnapshot = z.object({
  revision: z.number().int().min(1),
  agents: z.record(z.string(), AgentEgressPolicy),
});
export type EgressPolicySnapshot = z.infer<typeof EgressPolicySnapshot>;

export const EgressDecision = z.enum([
  "allowed",
  "blocked_domain",
  "blocked_attended",
  "blocked_address",
  "blocked_port",
  "blocked_method",
  "blocked_ip_literal",
  "frozen",
  "dns_failed",
  "connect_failed",
]);
export type EgressDecision = z.infer<typeof EgressDecision>;

// Read by the control plane with GET /v1/decisions?after=<seq>&wait=<seconds> (long poll).
export const EgressDecisionEvent = z.object({
  seq: z.number().int().min(1),
  at: z.string(),
  agentId: AgentId,
  listener: ListenerKind,
  host: z.string(),
  port: z.number().int(),
  method: z.string(),
  decision: EgressDecision,
  policyRevision: z.number().int(),
});
export type EgressDecisionEvent = z.infer<typeof EgressDecisionEvent>;

// GET /v1/decisions response. `epoch` changes whenever the proxy restarts and its sequence numbers start again from 1;
// a reader that sees a new epoch resets its cursor to 0.
export const EgressDecisionsResponse = z.object({
  epoch: z.string().min(8).max(64),
  events: z.array(EgressDecisionEvent),
});
export type EgressDecisionsResponse = z.infer<typeof EgressDecisionsResponse>;

// What the CLI sandbox may reach: the model provider and its sign-in endpoints. Pinned with the CLI version and
// confirmed from the proxy log on the host.
export const CLAUDE_CODE_EGRESS: readonly string[] = [
  "api.anthropic.com",
  "claude.ai",
  "platform.claude.com",
  "console.anthropic.com",
];

/** How a rule reads to the owner: *.roblox.com is the site roblox.com with its subdomains. */
export function siteLabel(pattern: string): string {
  return pattern.replace(/^\*\./, "");
}

export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase().replace(/\.$/, "");
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === p;
}
