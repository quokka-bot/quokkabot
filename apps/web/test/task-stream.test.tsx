import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { startTransition, Suspense, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskEvent } from "@quokkabot/shared";
import { useTaskStream } from "../src/task-stream.js";
import { at, taskId } from "./fixtures.js";

class MockEventSource {
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) { MockEventSource.instances.push(this); }
  close() {}
  emit(seq: number, event: TaskEvent) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ taskId, seq, at, event }), lastEventId: String(seq) }));
  }
}

beforeEach(() => { MockEventSource.instances = []; vi.stubGlobal("EventSource", MockEventSource); });
afterEach(() => { vi.unstubAllGlobals(); });

const never = new Promise<never>(() => undefined);
let open: (next: string) => void = () => undefined;

function Events({ id, waiting }: { id: string; waiting: boolean }) {
  const stream = useTaskStream(id);
  if (waiting) throw never;
  return <output aria-label="Events">{stream.events.length}</output>;
}

function Chat() {
  const [id, setId] = useState<string>(taskId);
  open = next => setId(next);
  return <Suspense fallback={null}><Events id={id} waiting={id !== taskId} /></Suspense>;
}

it("keeps the open task's events when React drops a render of another task", () => {
  render(<QueryClientProvider client={new QueryClient()}><Chat /></QueryClientProvider>);
  const source = MockEventSource.instances[0];
  if (!source) throw new Error("The task stream did not open");
  act(() => source.emit(1, { kind: "assistant_text", text: "Comparing the invoices." }));
  expect(screen.getByLabelText("Events").textContent).toBe("1");
  // A navigation to another task waits in a transition, then a new event for the open task renders first.
  act(() => startTransition(() => open("88888888-8888-4888-8888-888888888888")));
  act(() => source.emit(2, { kind: "assistant_text", text: "Three totals changed." }));
  expect(screen.getByLabelText("Events").textContent).toBe("2");
});
