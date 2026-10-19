import { TERMINAL_TASK_STATES, type OwnerRequest, type Task } from "@quokkabot/shared";
import type { Api } from "../api";

type ComposerTask = Pick<Task, "id" | "state" | "blockedReason">;
export function composerState(name: string, task: ComposerTask | null, waiting: boolean, question: Pick<OwnerRequest, "kind"> | null) {
  const active = task !== null && !TERMINAL_TASK_STATES.has(task.state);
  const running = active && !waiting;
  const route = task === null ? "createTask" : active && waiting ? "reply" : running ? null : "message";
  const placeholder = active && waiting ? (question?.kind === "question" ? `Answer ${name}` : `Reply to ${name}`)
    : running ? (task.blockedReason ? `${name} is waiting for you above` : `${name} is working…`)
    : task === null ? `New task for ${name}` : `Message ${name}`;
  return { route, running, placeholder } as const;
}

export async function sendDraft(api: Pick<Api, "createTask" | "reply" | "message">, input: {
  agentId: string; task: ComposerTask | null; waiting: boolean; ready: boolean; text: string; draftKey: string;
}): Promise<Task | null> {
  const text = input.text.trim();
  if (!input.ready || !text) return null;
  const { route } = composerState("", input.task, input.waiting, null);
  if (route === "createTask") return api.createTask(input.agentId, text, input.draftKey);
  if (route === "reply" && input.task) return api.reply(input.task.id, text);
  if (route === "message" && input.task) return api.message(input.task.id, text);
  return null;
}
