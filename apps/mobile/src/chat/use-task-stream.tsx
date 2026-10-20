import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { AppState } from "react-native";
import type { TaskEventEnvelope } from "@quokkabot/shared";
import { useSession, useSignedIn } from "../session";
import { openTaskStream } from "../stream";

// Open while the chat is on screen: another screen over it (the computer) or the app in the background closes the
// stream, and it continues from the last event when the chat shows again.
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
  // An error belongs to its scope like the events, so another task's error never shows here.
  const [failure, setFailure] = useState<{ scope: typeof cursor.current; error: Error | null }>({ scope: cursor.current, error: null });
  const [state, setState] = useState<"connecting" | "live" | "reconnecting" | "stopped">("connecting");
  const [revision, setRevision] = useState(0);
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => setForeground(next !== "background"));
    return () => subscription.remove();
  }, []);
  const visible = focused && foreground;
  useEffect(() => {
    if (taskId === null || !visible) return;
    let alive = true;
    const sequence = cursor.current;
    const setError = (error: Error | null) => setFailure({ scope: sequence, error });
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
          // Whether the agent is working: its avatars follow the stream instead of the next poll.
          void client.invalidateQueries({ queryKey: [connection.origin, "agents"] });
          void client.invalidateQueries({ queryKey: [connection.origin, "agent"] });
        }
      },
      onState: (next) => { if (alive) { setState(next); if (next === "live") setError(null); } },
      onError: (failure) => { if (alive) { setError(failure); if (failure.message.startsWith("Task event")) setState("stopped"); } },
      onSignedOut: () => { if (alive) void signOut("This phone was signed out. Sign in again."); },
    });
    return () => { alive = false; close(); };
  }, [client, connection.origin, connection.token, key, revision, signOut, taskId, visible]);
  return { events: output.scope === cursor.current ? output.events : [], error: failure.scope === cursor.current ? failure.error : null, connection: state, lastSeq: cursor.current.lastSeq,
    reconnect: () => setRevision(value => value + 1) };
}
