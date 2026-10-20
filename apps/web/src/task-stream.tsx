import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TaskEventEnvelope } from "@quokkabot/shared";
import { streamRows, TaskEventSequencer } from "@quokkabot/client";
import { api, taskEventsUrl } from "./api.js";
import { ErrorLine } from "./ui.js";

// `taskId` null: no task is open, and the stream is closed.
export function useTaskStream(taskId: string | null) {
  const client = useQueryClient();
  const [connection, setConnection] = useState("Connecting");
  const [revision, setRevision] = useState(0);
  // One sequencer per opening of a task, kept in state: a render React drops (a navigation it restarts) leaves the
  // open stream's sequencer in place. Events and errors belong to it, so another task, or the same task opened again,
  // starts empty in the same render instead of showing the previous task's events until an effect clears them.
  const [scope, setScope] = useState(() => ({ taskId, sequence: new TaskEventSequencer(taskId ?? "") }));
  if (scope.taskId !== taskId) setScope({ taskId, sequence: new TaskEventSequencer(taskId ?? "") });
  const [output, setOutput] = useState<{ sequence: TaskEventSequencer; events: TaskEventEnvelope[] }>({ sequence: scope.sequence, events: [] });
  const [failure, setFailure] = useState<{ sequence: TaskEventSequencer; error: unknown }>({ sequence: scope.sequence, error: null });
  // Stream failures in a row since the last open; the first one is retried quietly.
  const failures = useRef(0);
  useEffect(() => { failures.current = 0; }, [scope]);
  useEffect(() => {
    const { taskId: openTaskId, sequence } = scope;
    if (openTaskId === null) return;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const setError = (error: unknown) => setFailure({ sequence, error });
    const source = new EventSource(taskEventsUrl(openTaskId, sequence.lastSeq));
    setConnection("Connecting");
    source.onopen = () => { failures.current = 0; setConnection("Live"); setError(null); };
    source.onmessage = message => {
      try {
        const envelope = sequence.accept(message.lastEventId, message.data as string);
        if (envelope === null) return;
        setOutput(previous => ({ sequence, events: previous.sequence === sequence ? [...previous.events, envelope] : [envelope] }));
        if (["state", "run", "owner_request"].includes(envelope.event.kind)) {
          void client.invalidateQueries({ queryKey: ["task", openTaskId] });
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
  }, [scope, client, revision]);
  const current = scope.sequence;
  return {
    events: output.sequence === current ? output.events : [], error: failure.sequence === current ? failure.error : null,
    connection, lastSeq: current.lastSeq, reconnect: () => { failures.current = 0; setRevision(value => value + 1); },
  };
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
