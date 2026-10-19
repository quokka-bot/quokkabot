import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TaskEventEnvelope } from "@quokkabot/shared";
import { useSession, useSignedIn } from "../session";
import { openTaskStream } from "../stream";

export function useTaskStream(taskId: string | null) {
  const { connection } = useSignedIn();
  const { signOut } = useSession();
  const client = useQueryClient();
  const key = `${connection.origin}|${taskId}`;
  const cursor = useRef({ key, lastSeq: 0 });
  if (cursor.current.key !== key) cursor.current = { key, lastSeq: 0 };
  // A fresh scope on every task switch, including A -> new task -> A. Comparing just the task id would append
  // replayed history to A's old events if the intermediate screen had received no events.
  const [output, setOutput] = useState<{ scope: typeof cursor.current; events: TaskEventEnvelope[] }>({ scope: cursor.current, events: [] });
  const [error, setError] = useState<Error | null>(null);
  const [state, setState] = useState<"connecting" | "live" | "reconnecting" | "stopped">("connecting");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (taskId === null) return;
    let alive = true;
    const sequence = cursor.current;
    setError(null);
    const close = openTaskStream({ origin: connection.origin, token: connection.token, taskId, lastSeq: sequence.lastSeq,
      onEvent: (envelope) => {
        if (!alive) return;
        sequence.lastSeq = envelope.seq;
        setOutput(previous => ({ scope: sequence, events: [...(previous.scope === sequence ? previous.events : []), envelope] }));
        if (["state", "run", "owner_request", "domain_request", "domain_decided"].includes(envelope.event.kind)) {
          void client.invalidateQueries({ queryKey: [connection.origin, "task", taskId] });
          void client.invalidateQueries({ queryKey: [connection.origin, "inbox"] });
          void client.invalidateQueries({ queryKey: [connection.origin, "agent-tasks"] });
        }
      },
      onState: (next) => { if (alive) { setState(next); if (next === "live") setError(null); } },
      onError: (failure) => { if (alive) { setError(failure); if (failure.message.startsWith("Task event")) setState("stopped"); } },
      onSignedOut: () => { if (alive) void signOut("This phone was signed out. Sign in again."); },
    });
    return () => { alive = false; close(); };
  }, [client, connection.origin, connection.token, key, revision, signOut, taskId]);
  return { events: output.scope === cursor.current ? output.events : [], error, connection: state, lastSeq: cursor.current.lastSeq,
    reconnect: () => setRevision(value => value + 1) };
}
