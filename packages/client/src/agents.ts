import { AgentName, type AgentsResponse, type AgentSummary } from "@quokkabot/shared";

export type AgentNameEdit = { kind: "unchanged" } | { kind: "invalid"; message: string } | { kind: "save"; name: string };

// What saving a typed agent name does: nothing when it matches the current name, one plain line when AgentName refuses
// it, otherwise the trimmed name to send.
export function agentNameEdit(draft: string, current: string): AgentNameEdit {
  const parsed = AgentName.safeParse(draft);
  if (!parsed.success) return { kind: "invalid", message: parsed.error.issues[0]?.code === "too_big" ? `Use ${AgentName.maxLength} characters or fewer.` : "Type a name." };
  return parsed.data === current ? { kind: "unchanged" } : { kind: "save", name: parsed.data };
}

// The agents list with one agent replaced by the server's reply, so a rename shows in the list before its next poll.
export function withAgent(list: AgentsResponse | undefined, agent: AgentSummary): AgentsResponse | undefined {
  return list && { ...list, agents: list.agents.map(item => item.id === agent.id ? agent : item) };
}
