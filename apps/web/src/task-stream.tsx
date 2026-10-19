import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactionEmoji, TaskEventEnvelope } from "@quokkabot/shared";
import { api, errorMessage, parseTaskEvent, taskEventsUrl } from "./api.js";
import { ErrorLine } from "./ui.js";

export function useTaskStream(taskId: string) {
  const client = useQueryClient();
  const [events, setEvents] = useState<TaskEventEnvelope[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [connection, setConnection] = useState("Connecting");
  const [revision, setRevision] = useState(0);
  const lastSeq = useRef(0);
  const currentTask = useRef(taskId);
  if (currentTask.current !== taskId) {
    currentTask.current = taskId;
    lastSeq.current = 0;
  }
  // Stream failures in a row since the last open; the first one is retried quietly.
  const failures = useRef(0);
  useEffect(() => {
    setEvents([]);
    setError(null);
    failures.current = 0;
  }, [taskId]);
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource(taskEventsUrl(taskId, lastSeq.current));
    setConnection("Connecting");
    source.onopen = () => { failures.current = 0; setConnection("Live"); setError(null); };
    source.onmessage = message => {
      try {
        const envelope = parseTaskEvent(message.data as string);
        if (envelope.taskId !== taskId) throw new Error("Task event: task id does not match the open task");
        if (message.lastEventId !== String(envelope.seq)) throw new Error("Task event: SSE id does not match the event sequence");
        if (envelope.seq <= lastSeq.current) return;
        if (envelope.seq !== lastSeq.current + 1) throw new Error(`Task event: expected sequence ${lastSeq.current + 1}, received ${envelope.seq}`);
        lastSeq.current = envelope.seq;
        setEvents(previous => [...previous, envelope]);
        if (["state", "run", "owner_request"].includes(envelope.event.kind)) {
          void client.invalidateQueries({ queryKey: ["task", taskId] });
          void client.invalidateQueries({ queryKey: ["inbox"] });
        }
      } catch (eventError) {
        setError(eventError);
        setConnection("Stopped");
        source.close();
      }
    };
    source.onerror = () => {
      setConnection("Reconnecting");
      failures.current += 1;
      if (failures.current > 1) setError(new Error("Reconnecting to Quokka Bot…"));
      // An expired session answers 401 here, which routes to sign-in. Any other failure is the network or the server
      // restarting, and the stream comes back on its own.
      void api.me().catch(() => undefined);
      // The browser reconnects a dropped stream by itself and resends Last-Event-ID. A reconnect the server answered
      // with an error (502 while control restarts) closes the EventSource for good: open a new one from the last
      // validated sequence after a growing wait.
      if (source.readyState !== EventSource.CLOSED) return;
      retry = setTimeout(() => { if (alive) setRevision(value => value + 1); }, Math.min(15_000, 500 * 2 ** (failures.current - 1)));
    };
    return () => { alive = false; clearTimeout(retry); source.close(); };
  }, [taskId, client, revision]);
  return { events, error, connection, lastSeq: lastSeq.current, reconnect: () => { failures.current = 0; setRevision(value => value + 1); } };
}

type StreamRow = { key: number; kind: "text"; text: string; live: boolean; finalSeq: number | null } | { key: number; kind: "event"; envelope: TaskEventEnvelope };

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
      // Keep the draft's React key, but reactions must target the persisted final event.
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

export function TaskEventStream({ taskId, agentId, openRequestIds, stream }: {
  taskId: string; agentId: string; openRequestIds: ReadonlySet<string>; stream: ReturnType<typeof useTaskStream>;
}) {
  const rows = useMemo(() => streamRows(stream.events), [stream.events]);
  return <section aria-label="Task event stream">
    <div className="section-heading"><h2>Activity</h2><span className="meta" role="status">{stream.connection} · event {stream.lastSeq}</span></div>
    <ErrorLine error={stream.error} />
    {Boolean(stream.error) && <button onClick={stream.reconnect}>Reconnect</button>}
    {rows.length === 0 && <p className="muted">Waiting for task output.</p>}
    <div className="event-stream">{rows.map(row => {
      if (row.kind === "text") return <div key={row.key} className={`assistant-text plain${row.live ? " live-text" : ""}`}>{row.text}{row.live && <span className="live-caret" aria-label="Streaming" />}</div>;
      const { event } = row.envelope;
      switch (event.kind) {
        case "owner_message": return <div key={row.key} className="owner-text plain"><span className="eyebrow">You</span><p>{event.text}</p></div>;
        case "tool_call": return <p key={row.key} className="tool-line"><strong>{event.tool}</strong> · {event.summary}</p>;
        case "tool_result": return <p key={row.key} className="tool-line"><strong>{event.tool}</strong> · {event.status} · {event.summary}</p>;
        case "owner_request": return openRequestIds.has(event.request.id) ? null : <p key={row.key} className="tool-line">{event.request.kind === "question" ? "Question" : "Takeover"}: {event.request.text}</p>;
        case "state": return <p key={row.key} className="meta">Task {event.state}{event.blockedReason ? ` · ${event.blockedReason.replaceAll("_", " ")}` : ""}</p>;
        case "run": return <p key={row.key} className="meta">Run {event.run.attempt}: {event.run.state}{event.run.exitCode === null ? "" : ` · exit ${event.run.exitCode}`}</p>;
        case "error": return <ErrorLine key={row.key} error={new Error(event.message)} />;
        case "usage": return <p key={row.key} className="meta">Tokens: {event.inputTokens} in · {event.outputTokens} out{event.costUsd === null ? "" : ` · $${event.costUsd.toFixed(4)}`}</p>;
        default: return null;
      }
    })}</div>
    <span className="sr-only">Activity for task {taskId}, agent {agentId}</span>
  </section>;
}
