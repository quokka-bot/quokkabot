import { fetch } from "expo/fetch";
import type { TaskEventEnvelope } from "@quokkabot/shared";
import { createSseParser, TaskEventSequencer } from "@quokkabot/client";

// A task's events as they happen, over the server's event stream with the phone's token (React Native has no
// EventSource). The sequencer drops repeats and stops on a gap; a dropped connection comes back after a growing wait
// and continues from the last event. Stops for good on 401 (signed out) and when closed.
export function openTaskStream(opts: {
  origin: string; token: string; taskId: string; lastSeq: number;
  onEvent: (envelope: TaskEventEnvelope) => void; onState: (state: "connecting" | "live" | "reconnecting") => void;
  onError: (error: Error) => void; onSignedOut: () => void;
}): () => void {
  const sequencer = new TaskEventSequencer(opts.taskId, opts.lastSeq);
  let closed = false;
  let controller: AbortController | null = null;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = async (): Promise<void> => {
    if (closed) return;
    controller = new AbortController();
    opts.onState(failures === 0 ? "connecting" : "reconnecting");
    try {
      const response = await fetch(`${opts.origin}/api/tasks/${encodeURIComponent(opts.taskId)}/events?after=${sequencer.lastSeq}`, {
        headers: { Authorization: `Bearer ${opts.token}`, Accept: "text/event-stream" }, signal: controller.signal,
      });
      if (response.status === 401) { closed = true; opts.onSignedOut(); return; }
      if (!response.ok || !response.body) throw new Error(`The task stream answered HTTP ${response.status}`);
      failures = 0;
      opts.onState("live");
      const parser = createSseParser((event) => {
        const envelope = sequencer.accept(event.lastEventId, event.data);
        if (envelope !== null) opts.onEvent(envelope);
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (closed) return;
      // A gap or a malformed event is not a network problem: show it and stop.
      if (error instanceof Error && error.message.startsWith("Task event")) { closed = true; opts.onError(error); return; }
    }
    if (closed) return;
    failures += 1;
    if (failures > 1) opts.onError(new Error("Reconnecting…"));
    retry = setTimeout(() => void connect(), Math.min(15_000, 500 * 2 ** (failures - 1)));
  };
  void connect();
  return () => { closed = true; clearTimeout(retry); controller?.abort(); };
}
