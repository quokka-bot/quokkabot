import { Attachment, OwnerRequest, Run, TaskEventEnvelope, type TaskEvent } from "@quokkabot/shared";

export const agentId = "11111111-1111-4111-8111-111111111111";
export const taskId = "22222222-2222-4222-8222-222222222222";
export const runId = "33333333-3333-4333-8333-333333333333";
export const requestId = "44444444-4444-4444-8444-444444444444";
export const domainRequestId = "55555555-5555-4555-8555-555555555555";
export const at = "2026-10-17T08:00:00.000Z";
export const run = Run.parse({ id: runId, taskId, attempt: 1, state: "running", exitCode: null, startedAt: at, endedAt: null, lastEventAt: at });
export const ownerRequest = OwnerRequest.parse({ id: requestId, taskId, runId, kind: "question", text: "Which month should I collect?", whatToDo: null, site: null, loginName: null, loginId: null, connector: null, createdAt: at, answeredAt: null, answer: null });
export const attachment = Attachment.parse({ id: "66666666-6666-4666-8666-666666666666", name: "screen.png", mediaType: "image/png", bytes: 10, width: 10, height: 10 });

export function envelope(event: TaskEvent, seq = 1): TaskEventEnvelope {
  return TaskEventEnvelope.parse({ taskId, seq, at, event });
}

export function envelopes(events: readonly TaskEvent[]): TaskEventEnvelope[] {
  return events.map((event, index) => envelope(event, index + 1));
}
