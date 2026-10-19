import { beforeEach, expect, it, vi } from "vitest";
import type { TaskEventEnvelope } from "@quokkabot/shared";
import type { openTaskStream } from "../src/stream";

type StreamOptions = Parameters<typeof openTaskStream>[0];
type Effect = { deps: unknown[]; cleanup?: (() => void) | undefined };
// Run this hook's subscriptions under Node. No native modules, sockets or timers are opened.
const runtime = vi.hoisted(() => ({
  slots: [] as unknown[], index: 0, effects: [] as (() => void)[],
  subscriptions: [] as { options: StreamOptions; close: ReturnType<typeof vi.fn> }[],
  connection: { origin: "https://one.example.com", token: "phone-session" },
  open: vi.fn(), invalidate: vi.fn(), signOut: vi.fn().mockResolvedValue(undefined),
  focused: true, appState: undefined as ((state: string) => void) | undefined,
}));
vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const slot = runtime.index++;
    if (!(slot in runtime.slots)) runtime.slots[slot] = { current: initial };
    return runtime.slots[slot];
  },
  useState: (initial: unknown) => {
    const slot = runtime.index++;
    if (!(slot in runtime.slots)) runtime.slots[slot] = typeof initial === "function" ? initial() : initial;
    return [runtime.slots[slot], (next: unknown) => {
      runtime.slots[slot] = typeof next === "function" ? next(runtime.slots[slot]) : next;
    }];
  },
  useEffect: (setup: () => (() => void) | undefined, deps: unknown[]) => {
    const slot = runtime.index++;
    const previous = runtime.slots[slot] as Effect | undefined;
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    const effect: Effect = { deps };
    runtime.slots[slot] = effect;
    runtime.effects.push(() => { previous?.cleanup?.(); effect.cleanup = setup(); });
  },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => client }));
vi.mock("expo-router", () => ({ useIsFocused: () => runtime.focused }));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: (_type: string, listener: (state: string) => void) => {
  runtime.appState = listener; return { remove: vi.fn() };
} } }));
vi.mock("../src/session", () => ({
  useSignedIn: () => ({ connection: runtime.connection }), useSession: () => ({ signOut: runtime.signOut }),
}));
vi.mock("../src/stream", () => ({ openTaskStream: runtime.open }));
import { useTaskStream } from "../src/chat/use-task-stream";

const client = { invalidateQueries: runtime.invalidate };
function render(taskId: string | null) {
  runtime.index = 0;
  const result = useTaskStream(taskId);
  for (const effect of runtime.effects.splice(0)) effect();
  return result;
}
function subscription() { return runtime.subscriptions.at(-1) as (typeof runtime.subscriptions)[number]; }
function event(seq: number, kind: "assistant_text" | "state" | "run" | "owner_request" = "assistant_text") {
  return { taskId: "task-a", seq, at: "2026-10-19T12:00:00Z", event: { kind, text: "Response" } } as TaskEventEnvelope;
}
beforeEach(() => {
  vi.clearAllMocks(); runtime.slots = []; runtime.effects = []; runtime.subscriptions = []; runtime.index = 0;
  runtime.focused = true; runtime.appState = undefined;
  runtime.connection = { origin: "https://one.example.com", token: "phone-session" };
  runtime.open.mockImplementation((options: StreamOptions) => {
    const close = vi.fn(); runtime.subscriptions.push({ options, close }); return close;
  });
});
it("reconnects from the last event and retains the conversation", () => {
  render("task-a");
  const first = subscription();
  expect(first.options).toMatchObject({ origin: runtime.connection.origin, token: runtime.connection.token, taskId: "task-a", lastSeq: 0 });
  first.options.onEvent(event(1));
  const stream = render("task-a");
  expect(stream.events).toEqual([event(1)]);
  stream.reconnect(); render("task-a");
  expect(first.close).toHaveBeenCalledOnce();
  expect(subscription().options.lastSeq).toBe(1);
  subscription().options.onEvent(event(2));
  expect(render("task-a").events).toEqual([event(1), event(2)]);
});
it("does not duplicate history when reopening a task after an empty new-task screen", () => {
  render("task-a"); const first = subscription(); first.options.onEvent(event(1)); render("task-a");
  expect(render(null).events).toEqual([]);
  expect(first.close).toHaveBeenCalledOnce();
  expect(render("task-a").events).toEqual([]);
  const reopened = subscription(); expect(reopened.options.lastSeq).toBe(0);
  first.options.onEvent(event(2));
  reopened.options.onEvent(event(1));
  expect(render("task-a").events).toEqual([event(1)]);
});
it("starts a new history when the server changes, even for the same task id", () => {
  render("task-a"); const first = subscription(); first.options.onEvent(event(1)); render("task-a");
  runtime.connection = { origin: "https://two.example.com", token: "another-session" };
  expect(render("task-a").events).toEqual([]);
  expect(first.close).toHaveBeenCalledOnce();
  expect(subscription().options).toMatchObject({ origin: runtime.connection.origin, lastSeq: 0 });
});
it.each(["state", "run", "owner_request"] as const)("invalidates task, inbox and tasks for this server on %s", kind => {
  render("task-a"); subscription().options.onEvent(event(1, kind));
  expect(runtime.invalidate.mock.calls.map(([input]) => input)).toEqual([
    { queryKey: [runtime.connection.origin, "task", "task-a"] }, { queryKey: [runtime.connection.origin, "inbox"] },
    { queryKey: [runtime.connection.origin, "agent-tasks"] },
  ]);
});
it("exposes stopped errors, clears them when live, and signs out on an expired session", () => {
  render("task-a"); const { options } = subscription(); const error = new Error("Task event: sequence gap");
  options.onError(error);
  expect(render("task-a")).toMatchObject({ error, connection: "stopped" });
  options.onState("live"); expect(render("task-a")).toMatchObject({ error: null, connection: "live" });
  options.onSignedOut(); expect(runtime.signOut).toHaveBeenCalledExactlyOnceWith("This phone was signed out. Sign in again.");
});
it("closes the stream while the chat is hidden or the app is in the background, and continues from the last event", () => {
  render("task-a"); const first = subscription(); first.options.onEvent(event(1)); render("task-a");
  runtime.appState?.("background"); render("task-a");
  expect(first.close).toHaveBeenCalledOnce();
  expect(runtime.subscriptions).toHaveLength(1);
  runtime.appState?.("inactive"); render("task-a");
  const resumed = subscription(); expect(resumed.options.lastSeq).toBe(1);
  runtime.focused = false; render("task-a");
  expect(resumed.close).toHaveBeenCalledOnce();
  runtime.focused = true; render("task-a");
  expect(runtime.subscriptions).toHaveLength(3);
  expect(subscription().options.lastSeq).toBe(1);
  expect(render("task-a").events).toEqual([event(1)]);
});
