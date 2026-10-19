import { describe, expect, it } from "vitest";
import { messageReactions, parseTaskEvent, streamRows, TaskEventSequencer } from "../src/index.js";
import { envelope, envelopes, run, taskId } from "./fixtures.js";

describe("streamRows", () => {
  it("joins deltas and replaces the draft with final text, retaining the first key and final reaction target", () => {
    const events = envelopes([
      { kind: "assistant_delta", text: "Draft " },
      { kind: "assistant_delta", text: "text" },
      { kind: "tool_call", tool: "browser_open", summary: "Open billing" },
      { kind: "assistant_text", text: "Saved the invoice." },
      { kind: "assistant_text", text: "Another message." },
      { kind: "assistant_delta", text: "Next draft" },
    ]);
    expect(streamRows(events.slice(0, 2))).toEqual([{ key: 1, kind: "text", text: "Draft text", live: true, finalSeq: null }]);
    expect(streamRows(events)).toEqual([
      { key: 1, kind: "text", text: "Saved the invoice.", live: false, finalSeq: 4 },
      { key: 3, kind: "event", envelope: events[2] },
      { key: 5, kind: "text", text: "Another message.", live: false, finalSeq: 5 },
      { key: 6, kind: "text", text: "Next draft", live: true, finalSeq: null },
    ]);
    expect(events[0]?.event).toEqual({ kind: "assistant_delta", text: "Draft " });
  });

  it("does not join text across run boundaries and retains other event rows", () => {
    const events = envelopes([
      { kind: "assistant_delta", text: "Interrupted" },
      { kind: "run", run: { ...run, state: "lost" } },
      { kind: "assistant_delta", text: "New run" },
      { kind: "assistant_text", text: "New answer" },
      { kind: "reaction", targetSeq: 4, by: "owner", emoji: "👍" },
    ]);
    expect(streamRows(events)).toEqual([
      { key: 1, kind: "text", text: "Interrupted", live: true, finalSeq: null },
      { key: 2, kind: "event", envelope: events[1] },
      { key: 3, kind: "text", text: "New answer", live: false, finalSeq: 4 },
      { key: 5, kind: "event", envelope: events[4] },
    ]);
    expect(streamRows([])).toEqual([]);
  });
});

describe("messageReactions", () => {
  it("replays replacements and removals independently for each author and message", () => {
    const events = envelopes([
      { kind: "assistant_text", text: "Saved." },
      { kind: "reaction", targetSeq: 1, by: "owner", emoji: "👍" },
      { kind: "reaction", targetSeq: 1, by: "agent", emoji: "👀" },
      { kind: "reaction", targetSeq: 1, by: "owner", emoji: "✅" },
      { kind: "reaction", targetSeq: 2, by: "agent", emoji: "🎉" },
      { kind: "reaction", targetSeq: 1, by: "agent", emoji: null },
    ]);
    expect([...messageReactions(events)]).toEqual([[1, { owner: "✅" }], [2, { agent: "🎉" }]]);
    expect([...messageReactions([...events, envelope({ kind: "reaction", targetSeq: 1, by: "owner", emoji: null }, 7)])]).toEqual([[1, {}], [2, { agent: "🎉" }]]);
    expect(messageReactions([]).size).toBe(0);
  });
});

describe("TaskEventSequencer", () => {
  const data = (seq: number) => JSON.stringify(envelope({ kind: "assistant_text", text: "Saved." }, seq));

  it("accepts consecutive validated events and ignores duplicate and older sequences", () => {
    const sequencer = new TaskEventSequencer(taskId);
    expect(sequencer.lastSeq).toBe(0);
    expect(sequencer.accept("1", data(1))?.seq).toBe(1);
    expect(sequencer.accept("2", data(2))?.seq).toBe(2);
    expect(sequencer.accept("2", data(2))).toBeNull();
    expect(sequencer.accept("1", data(1))).toBeNull();
    expect(sequencer.lastSeq).toBe(2);
    expect(sequencer.accept("3", data(3))?.seq).toBe(3);
  });

  it("resumes from a previously validated sequence", () => {
    const sequencer = new TaskEventSequencer(taskId, 4);
    expect(sequencer.accept("4", data(4))).toBeNull();
    expect(sequencer.accept("5", data(5))?.seq).toBe(5);
    expect(sequencer.lastSeq).toBe(5);
  });

  it("rejects a task mismatch before dropping a duplicate", () => {
    const sequencer = new TaskEventSequencer(taskId, 1);
    const other = { ...JSON.parse(data(1)), taskId: "77777777-7777-4777-8777-777777777777" };
    expect(() => sequencer.accept("1", JSON.stringify(other))).toThrow("Task event: task id does not match the open task");
    expect(sequencer.lastSeq).toBe(1);
  });

  it.each(["", "01", "2", "1\n"])("rejects a mismatched SSE id: %j", id => {
    const sequencer = new TaskEventSequencer(taskId);
    expect(() => sequencer.accept(id, data(1))).toThrow("Task event: SSE id does not match the event sequence");
    expect(sequencer.lastSeq).toBe(0);
    expect(sequencer.accept("1", data(1))?.seq).toBe(1);
    expect(() => sequencer.accept(id, data(1))).toThrow("SSE id does not match");
  });

  it("rejects gaps without advancing the cursor, allowing the missing event to be replayed", () => {
    const sequencer = new TaskEventSequencer(taskId);
    expect(() => sequencer.accept("2", data(2))).toThrow("Task event: expected sequence 1, received 2");
    expect(sequencer.lastSeq).toBe(0);
    sequencer.accept("1", data(1));
    expect(() => sequencer.accept("3", data(3))).toThrow("Task event: expected sequence 2, received 3");
    expect(sequencer.lastSeq).toBe(1);
    expect(sequencer.accept("2", data(2))?.seq).toBe(2);
  });

  it("rejects malformed JSON and schemas without acknowledging their sequence", () => {
    const sequencer = new TaskEventSequencer(taskId);
    expect(() => sequencer.accept("1", "{")).toThrow("Task event: invalid JSON");
    const invalid = { ...JSON.parse(data(1)), event: { kind: "assistant_delta", text: 12 } };
    expect(() => sequencer.accept("1", JSON.stringify(invalid))).toThrow("Task event: invalid response at event.text");
    expect(() => sequencer.accept("1", "null")).toThrow("Task event: invalid response at root");
    expect(sequencer.lastSeq).toBe(0);
    expect(sequencer.accept("1", data(1))?.seq).toBe(1);
  });

  it("keeps shared schema defaults for older owner messages", () => {
    const event = { ...JSON.parse(data(1)), event: { kind: "owner_message", text: "Hello" } };
    expect(parseTaskEvent(JSON.stringify(event)).event).toEqual({ kind: "owner_message", text: "Hello", attachments: [] });
  });
});
