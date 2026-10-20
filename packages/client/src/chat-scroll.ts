import type { TaskEventEnvelope } from "@quokkabot/shared";

// Opening a chat shows its latest messages at once. Afterwards new content keeps the view at the end only while the
// owner is at the end; an owner reading older messages stays where they are.

// How far above the end, in pixels (points on the iPhone), still counts as being at the end.
export const NEAR_END = 48;

// `offset` is how far the view is scrolled, `viewport` the height it shows, `content` the height of everything in it.
export function nearEnd(view: { offset: number; viewport: number; content: number }): boolean {
  return view.content - view.offset - view.viewport <= NEAR_END;
}

// Whether the view keeps following the end after a scroll from `from` to `view.offset`. Only a scroll up leaves the
// end: the chat's own scroll to the end, read after more content has arrived, is still following.
export function followsEnd(following: boolean, from: number, view: { offset: number; viewport: number; content: number }): boolean {
  if (nearEnd(view)) return true;
  return view.offset < from ? false : following;
}

// A loaded query as the chat sees it (TanStack Query's result has these fields). Its data counts once it was fetched
// on this visit: a cached copy may miss newer tasks and events.
export type ChatQuery<T> = { data: T | undefined; error: unknown; isFetchedAfterMount: boolean };

function fetched<T>(query: ChatQuery<T>): T | undefined {
  return query.isFetchedAfterMount ? query.data : undefined;
}

// What a chat being opened has so far. `task` is null when no task is selected (no tasks yet, or a new task).
export type ChatOpening = {
  tasks: ChatQuery<unknown>;
  task: ChatQuery<{ lastSeq: number }> | null;
  events: readonly TaskEventEnvelope[];
  streamFailed: boolean;
};

// The chat shows once it has everything it opens with: the task list, the selected task, and its events up to that
// task's lastSeq. A failure to load the list or the task shows at once. A failed stream shows once the task is
// loaded, because its error and Reconnect sit under the task.
export function chatOpened(state: ChatOpening): boolean {
  if (state.tasks.error || state.task?.error) return true;
  if (fetched(state.tasks) === undefined) return false;
  if (state.task === null) return true;
  const task = fetched(state.task);
  return task !== undefined && (state.streamFailed || (state.events.at(-1)?.seq ?? 0) >= task.lastSeq);
}
