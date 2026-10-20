import { useState } from "react";
import { AGENT_PROVIDER, AI_CONSENT_ERROR, AI_PROVIDERS, type AgentSummary, type AiConsentView } from "@quokkabot/shared";
import { api, ApiFailure } from "./api.js";
import { dateLabel, ErrorLine, useAction } from "./ui.js";

const PROVIDER = AI_PROVIDERS[AGENT_PROVIDER];
const CLIENT_NAMES: Record<NonNullable<AiConsentView["changedBy"]>["client"], string> = { browser: "web app", desktop: "Mac app", phone: "iPhone app" };

export const needsAiConsent = (error: unknown): boolean => error instanceof ApiFailure && error.code === AI_CONSENT_ERROR;

// The server's record of the owner's permission. The web app is served by the server it talks to, so it is always there.
export function aiConsentOf(agent: AgentSummary): AiConsentView {
  if (!agent.aiConsent) throw new Error(`The server sent ${agent.name} without its AI provider permission.`);
  return agent.aiConsent;
}

// Asked before a send to an agent whose permission is off or not given, with the same text as the iPhone app. Allow
// returns to the chat; the owner sends again.
export function AiConsentCard({ agent, onClose }: { agent: AgentSummary; onClose: () => void }) {
  const allow = useAction(async () => {
    await api.setAiConsent(agent.id, { allow: true, provider: AGENT_PROVIDER, disclosureVersion: PROVIDER.disclosureVersion, generation: agent.generation });
    onClose();
  });
  return <section className="card consent-card" aria-label={`${agent.name} works with ${PROVIDER.name}`}>
    <h3>{agent.name} works with {PROVIDER.name}</h3>
    <p>What you send {agent.name}, the pages its computer opens and the files it works on go to {PROVIDER.company}, so Claude can do the task.</p>
    <p>They go through the Claude account signed in on {agent.name}'s computer, under {PROVIDER.company}'s terms and <a href={PROVIDER.privacyUrl} target="_blank" rel="noreferrer">privacy policy</a>.</p>
    <p>Your choice holds in every app you use with this server. You can turn it off in {agent.name}'s settings.</p>
    <div className="actions wrap">
      <button type="button" className="pill dark" disabled={allow.isPending} onClick={() => allow.mutate()}>Allow for {agent.name}</button>
      <button type="button" className="pill" disabled={allow.isPending} onClick={onClose}>Not now</button>
    </div>
    <ErrorLine error={allow.error} />
  </section>;
}

export function AiConsentSetting({ agent }: { agent: AgentSummary }) {
  const consent = aiConsentOf(agent);
  const [asking, setAsking] = useState(false);
  const withdraw = useAction(() => api.setAiConsent(agent.id, { allow: false, provider: AGENT_PROVIDER }));
  return <section className="card" aria-label="AI provider">
    <h2>AI provider</h2>
    <label className="switch"><input type="checkbox" checked={consent.allowed} disabled={withdraw.isPending || asking}
      onChange={event => { if (event.target.checked) setAsking(true); else withdraw.mutate(); }} />Send to {PROVIDER.name}</label>
    <p className="meta">Off: no app sends anything to {PROVIDER.company} for {agent.name}, and its queued and running tasks stop.</p>
    {consent.changedAt && consent.changedBy && <p className="meta">
      {consent.state === "withdrawn" ? "Turned off" : "Changed"} {dateLabel(consent.changedAt)} in the {CLIENT_NAMES[consent.changedBy.client]} on {consent.changedBy.deviceName}.
    </p>}
    {asking && <AiConsentCard agent={agent} onClose={() => setAsking(false)} />}
    <ErrorLine error={withdraw.error} />
  </section>;
}
