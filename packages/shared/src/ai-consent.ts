import { z } from "zod";

// The AI providers an agent can send to, and what the owner is told before allowing one (App Review 5.1.2(i)).
// A new disclosure version asks every app again: records made under an older version no longer count.
export const AiProvider = z.enum(["anthropic"]);
export type AiProvider = z.infer<typeof AiProvider>;

export const AI_PROVIDERS = {
  anthropic: {
    name: "Claude by Anthropic",
    company: "Anthropic",
    privacyUrl: "https://www.anthropic.com/legal/privacy",
    disclosureVersion: "2026-10-20",
  },
} as const satisfies Record<AiProvider, { name: string; company: string; privacyUrl: string; disclosureVersion: string }>;

// Every agent runs on Claude Code today.
export const AGENT_PROVIDER: AiProvider = "anthropic";

export const AiConsentClient = z.enum(["browser", "desktop", "phone"]);
export type AiConsentClient = z.infer<typeof AiConsentClient>;

// The server's record of the owner's permission for one agent and provider.
//   state "granted": the owner allowed it under the current disclosure.
//   state "withdrawn": the owner turned it off; nothing is sent until they allow it again.
//   state "not_asked": no current record. `required` says whether this server then refuses to send (the hosted cloud)
//   or sends, because the owner who installed the server chose the provider (self-hosted).
// `allowed` is what dispatch decides: a task runs only when it is true.
export const AiConsentView = z.object({
  provider: AiProvider,
  disclosureVersion: z.string(),
  state: z.enum(["granted", "withdrawn", "not_asked"]),
  required: z.boolean(),
  allowed: z.boolean(),
  changedAt: z.string().nullable(),
  changedBy: z.object({ client: AiConsentClient, deviceName: z.string() }).nullable(),
});
export type AiConsentView = z.infer<typeof AiConsentView>;

// GET /api/agents/:agentId/ai-consent                     -> AiConsentView
// PUT /api/agents/:agentId/ai-consent  AiConsentRequest   -> AiConsentView
// Allowing names the disclosure version the app showed and the agent generation it showed it for: a changed
// disclosure (409 disclosure_changed) or a replaced agent (409 agent_replaced) is refused, so the owner sees the
// current text for the current agent. Withdrawing stops the agent's queued and running tasks before anything more
// reaches the provider.
export const AiConsentRequest = z.discriminatedUnion("allow", [
  z.object({ allow: z.literal(true), provider: AiProvider, disclosureVersion: z.string().min(1).max(40), generation: z.number().int().positive() }).strict(),
  z.object({ allow: z.literal(false), provider: AiProvider }).strict(),
]);
export type AiConsentRequest = z.infer<typeof AiConsentRequest>;

// The error code a send gets when the agent has no consent; apps open their permission screen on it.
export const AI_CONSENT_ERROR = "ai_consent_required";

export function aiConsentRefusal(state: AiConsentView["state"]): string {
  const { company } = AI_PROVIDERS[AGENT_PROVIDER];
  return state === "withdrawn"
    ? `Sending to ${company} is off for this agent. Turn it on to send.`
    : `Allow sending to ${company} for this agent first.`;
}

// The error a task ends with when dispatch finds no consent: withdrawn while it was queued or running, or never given
// on a server that requires it.
export function aiConsentStopped(state: AiConsentView["state"]): string {
  const { company } = AI_PROVIDERS[AGENT_PROVIDER];
  return state === "withdrawn"
    ? `Stopped: sending to ${company} is off for this agent.`
    : `Not sent: allow sending to ${company} for this agent, then send it again.`;
}
