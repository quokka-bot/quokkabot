import { AI_PROVIDERS, AgentSummary, AiConsentView, DomainRequestView, OwnerRequest, Run, Task, TaskDetail } from "@quokkabot/shared";

export const agentId = "11111111-1111-4111-8111-111111111111";
export const taskId = "22222222-2222-4222-8222-222222222222";
export const runId = "33333333-3333-4333-8333-333333333333";
export const requestId = "44444444-4444-4444-8444-444444444444";
export const domainRequestId = "55555555-5555-4555-8555-555555555555";
export const at = "2026-10-17T08:00:00.000Z";
export const agent = AgentSummary.parse({
  id: agentId, name: "Office", model: "claude-opus-4-6", effort: "high", cliSignedIn: "yes",
  computer: { state: "stopped", sandboxes: [], lease: { holder: "agent", generation: 1, expiresAt: null }, attendedOpen: false, killedAt: null },
  activeTaskId: null, waitingOnOwner: 0,
  aiConsent: { provider: "anthropic", disclosureVersion: AI_PROVIDERS.anthropic.disclosureVersion, state: "not_asked", required: false, allowed: true, changedAt: null, changedBy: null },
});
export const withdrawnConsent = AiConsentView.parse({ ...agent.aiConsent, state: "withdrawn", allowed: false, changedAt: at, changedBy: { client: "phone", deviceName: "Owner's iPhone" } });
export const task = Task.parse({ id: taskId, agentId, title: "Download October invoices", state: "running", blockedReason: null, model: agent.model, effort: agent.effort, createdAt: at, updatedAt: at, result: null, error: null });
export const run = Run.parse({ id: runId, taskId, attempt: 1, state: "running", exitCode: null, startedAt: at, endedAt: null, lastEventAt: at });
export const ownerRequest = OwnerRequest.parse({ id: requestId, taskId, runId, kind: "question", text: "Which month should I collect?", whatToDo: null, site: null, loginName: null, loginId: null, connector: null, createdAt: at, answeredAt: null, answer: null });
export const domainRequest = DomainRequestView.parse({ id: domainRequestId, taskId, domains: ["billing.example.com"], reason: "Download the invoice", createdAt: at, decidedAt: null, decision: null });
export const detail = TaskDetail.parse({ task, runs: [run], openRequests: [], lastSeq: 0 });
export const me = { ownerName: "Ada", passkeys: 1, freshUntil: null };
export const emptyDomains = { rules: [], pending: [], blocked: [] };
export const hash = "a".repeat(64);

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
