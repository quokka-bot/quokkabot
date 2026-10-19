import { TaskEventEnvelope, type ReactionEmoji } from "@quokkabot/shared";

export function parseTaskEvent(data: string): TaskEventEnvelope {
  const parsed = TaskEventEnvelope.safeParse(JSON.parse(data) as unknown);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Task event: invalid response at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}

export class TaskEventSequencer {
  private sequence: number;

  constructor(readonly taskId: string, lastSeq = 0) {
    this.sequence = lastSeq;
  }

  get lastSeq(): number { return this.sequence; }

  accept(lastEventId: string, data: string): TaskEventEnvelope | null {
    const envelope = parseTaskEvent(data);
    if (envelope.taskId !== this.taskId) throw new Error("Task event: task id does not match the open task");
    if (lastEventId !== String(envelope.seq)) throw new Error("Task event: SSE id does not match the event sequence");
    if (envelope.seq <= this.sequence) return null;
    if (envelope.seq !== this.sequence + 1) throw new Error(`Task event: expected sequence ${this.sequence + 1}, received ${envelope.seq}`);
    this.sequence = envelope.seq;
    return envelope;
  }
}

export type StreamRow = { key: number; kind: "text"; text: string; live: boolean; finalSeq: number | null } | { key: number; kind: "event"; envelope: TaskEventEnvelope };

export function messageReactions(events: readonly TaskEventEnvelope[]): Map<number, Partial<Record<"owner" | "agent", ReactionEmoji>>> {
  const reactions = new Map<number, Partial<Record<"owner" | "agent", ReactionEmoji>>>();
  for (const { event } of events) {
    if (event.kind !== "reaction") continue;
    const current = reactions.get(event.targetSeq) ?? {};
    if (event.emoji === null) delete current[event.by];
    else current[event.by] = event.emoji;
    reactions.set(event.targetSeq, current);
  }
  return reactions;
}

export function streamRows(events: readonly TaskEventEnvelope[]): StreamRow[] {
  const rows: StreamRow[] = [];
  let liveIndex: number | null = null;
  for (const envelope of events) {
    const event = envelope.event;
    if (event.kind === "assistant_delta") {
      const pending = liveIndex === null ? undefined : rows[liveIndex];
      if (pending?.kind === "text") pending.text += event.text;
      else {
        liveIndex = rows.length;
        rows.push({ key: envelope.seq, kind: "text", text: event.text, live: true, finalSeq: null });
      }
    } else if (event.kind === "assistant_text") {
      const pending = liveIndex === null ? undefined : rows[liveIndex];
      // Keep the draft's key, but reactions must target the persisted final event.
      if (pending?.kind === "text") { pending.text = event.text; pending.live = false; pending.finalSeq = envelope.seq; }
      else rows.push({ key: envelope.seq, kind: "text", text: event.text, live: false, finalSeq: envelope.seq });
      liveIndex = null;
    } else {
      rows.push({ key: envelope.seq, kind: "event", envelope });
      if (event.kind === "run") liveIndex = null;
    }
  }
  return rows;
}

