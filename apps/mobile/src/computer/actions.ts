import type { Api } from "../api";
import { withConsent } from "../consent";

// Computer actions that let the agent see more ask for the AI provider permission first, as a message does. Without
// it the permission screen opens and nothing is sent; the owner taps again after allowing.
type Run = (work: () => Promise<unknown>) => void;

// Handing control back lets the agent see and drive the computer again. A takeover the agent asked for ends with
// "I'm done", which also tells the agent; one the owner started hands back.
export function handBack(origin: string, agentId: string, askedTaskId: string | null, api: Pick<Api, "takeover" | "takeoverDone">, run: Run): void {
  withConsent(origin, agentId, () => run(() => askedTaskId === null ? api.takeover(agentId, "return") : api.takeoverDone(askedTaskId)));
}

// The attended session makes the sites approved "only while I watch" reachable for the agent. Opening it asks for the
// permission; closing it never does.
export function setAttended(origin: string, agentId: string, open: boolean, api: Pick<Api, "attended">, run: Run): void {
  if (!open) { run(() => api.attended(agentId, false)); return; }
  withConsent(origin, agentId, () => run(() => api.attended(agentId, true)));
}
