import { describe, expect, it } from "vitest";
import { chatOpened, followsEnd, nearEnd, NEAR_END } from "../src/index.js";
import { envelopes } from "./fixtures.js";

describe("nearEnd", () => {
  it("counts the end and the last few lines above it as the end", () => {
    expect(nearEnd({ offset: 1400, viewport: 600, content: 2000 })).toBe(true);
    expect(nearEnd({ offset: 1400 - NEAR_END, viewport: 600, content: 2000 })).toBe(true);
    expect(nearEnd({ offset: 1400 - NEAR_END - 1, viewport: 600, content: 2000 })).toBe(false);
    expect(nearEnd({ offset: 0, viewport: 600, content: 2000 })).toBe(false);
  });

  it("treats a chat shorter than the view, and a bounce past the end, as the end", () => {
    expect(nearEnd({ offset: 0, viewport: 600, content: 300 })).toBe(true);
    expect(nearEnd({ offset: 1460, viewport: 600, content: 2000 })).toBe(true);
  });
});

describe("followsEnd", () => {
  it("stops following only when the owner scrolls up away from the end", () => {
    expect(followsEnd(true, 1400, { offset: 900, viewport: 600, content: 2000 })).toBe(false);
    expect(followsEnd(true, 1400, { offset: 1380, viewport: 600, content: 2000 })).toBe(true);
  });

  it("keeps following when its own scroll to the end is read after more content arrived", () => {
    expect(followsEnd(true, 1400, { offset: 1400, viewport: 600, content: 2600 })).toBe(true);
  });

  it("follows again at the end, and stays off while the owner scrolls down through older messages", () => {
    expect(followsEnd(false, 900, { offset: 1400, viewport: 600, content: 2000 })).toBe(true);
    expect(followsEnd(false, 300, { offset: 900, viewport: 600, content: 2000 })).toBe(false);
  });
});

describe("chatOpened", () => {
  const events = envelopes([
    { kind: "owner_message", text: "Compare the invoices", attachments: [] },
    { kind: "assistant_text", text: "Comparing them now." },
    { kind: "assistant_text", text: "Done." },
  ]);
  const loading = { data: undefined, error: null, isFetchedAfterMount: false };
  const fetched = <T,>(data: T) => ({ data, error: null, isFetchedAfterMount: true });
  const failed = { data: undefined, error: new Error("Quokka Bot did not answer."), isFetchedAfterMount: true };
  const list = fetched({ tasks: [] });

  it("waits for the task list and the selected task", () => {
    expect(chatOpened({ tasks: loading, task: loading, events: [], streamFailed: false })).toBe(false);
    expect(chatOpened({ tasks: list, task: loading, events, streamFailed: false })).toBe(false);
  });

  it("waits until the events reach the task's lastSeq, and opens when they do", () => {
    expect(chatOpened({ tasks: list, task: fetched({ lastSeq: 3 }), events: [], streamFailed: false })).toBe(false);
    expect(chatOpened({ tasks: list, task: fetched({ lastSeq: 3 }), events: events.slice(0, 2), streamFailed: false })).toBe(false);
    expect(chatOpened({ tasks: list, task: fetched({ lastSeq: 3 }), events, streamFailed: false })).toBe(true);
    expect(chatOpened({ tasks: list, task: fetched({ lastSeq: 2 }), events, streamFailed: false })).toBe(true);
  });

  it("opens at once with no task selected or a task without events", () => {
    expect(chatOpened({ tasks: list, task: null, events: [], streamFailed: false })).toBe(true);
    expect(chatOpened({ tasks: list, task: fetched({ lastSeq: 0 }), events: [], streamFailed: false })).toBe(true);
  });

  it("waits for a task list or task fetched on this visit, not a cached copy", () => {
    const cached = <T,>(data: T) => ({ data, error: null, isFetchedAfterMount: false });
    expect(chatOpened({ tasks: cached({ tasks: [] }), task: null, events: [], streamFailed: false })).toBe(false);
    expect(chatOpened({ tasks: list, task: cached({ lastSeq: 1 }), events, streamFailed: false })).toBe(false);
  });

  it("opens on a failure at once, with what has loaded", () => {
    expect(chatOpened({ tasks: failed, task: null, events: [], streamFailed: false })).toBe(true);
    expect(chatOpened({ tasks: list, task: failed, events: [], streamFailed: false })).toBe(true);
    expect(chatOpened({ tasks: loading, task: failed, events: [], streamFailed: false })).toBe(true);
    expect(chatOpened({ tasks: list, task: fetched({ lastSeq: 3 }), events: events.slice(0, 1), streamFailed: true })).toBe(true);
  });

  it("shows a failed stream once the task is loaded, where its error and Reconnect are", () => {
    expect(chatOpened({ tasks: list, task: loading, events: [], streamFailed: true })).toBe(false);
  });
});
