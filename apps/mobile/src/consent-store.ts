import { AGENT_PROVIDER, AI_PROVIDERS, type AgentSummary, type AiConsentView } from "@quokkabot/shared";

// The server's record of the owner's permission to send each agent's work to its AI provider, as this phone last read
// it (with the agent list, an agent, or the answer to a change). The server keeps the record and every app follows it;
// the phone only remembers what the server said, in memory.
export const PROVIDER = AI_PROVIDERS[AGENT_PROVIDER];

// null: the server keeps no records (older than the phone). undefined: not read yet.
const known = new Map<string, AiConsentView | null>();
const listeners = new Set<() => void>();
const key = (origin: string, agentId: string) => `${origin}|${agentId}`;
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function rememberAgentConsent(origin: string, agent: AgentSummary): void {
  known.set(key(origin, agent.id), agent.aiConsent);
  changed();
}
export function rememberConsent(origin: string, agentId: string, view: AiConsentView): void {
  known.set(key(origin, agentId), view);
  changed();
}
// The server refused a send for want of permission: the phone's copy is out of date.
export function forgetConsent(origin: string, agentId: string): void {
  known.delete(key(origin, agentId));
  changed();
}

export function consentRecord(origin: string, agentId: string): AiConsentView | null | undefined {
  return known.get(key(origin, agentId));
}

// The phone sends only after the owner allowed this provider, under the notice this build shows (App Review
// 5.1.2(i)). A server that sends without a record (self-hosted) still gets asked here first.
export function hasConsent(origin: string, agentId: string): boolean {
  const view = known.get(key(origin, agentId));
  return view?.state === "granted" && view.disclosureVersion === PROVIDER.disclosureVersion;
}

export function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const consentVersion = (): number => version;
