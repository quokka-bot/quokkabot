import { describe, expect, it } from "vitest";
import { createSseParser, TaskEventSequencer, type SseEvent } from "../src/index.js";
import { envelope, taskId } from "./fixtures.js";

function parse(chunks: readonly string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = createSseParser(event => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  return events;
}

describe("createSseParser", () => {
  it.each(["\n", "\r\n", "\r"])("parses multiple events and multi-line data with %j line endings at every chunk boundary", newline => {
    const text = ["\uFEFF: heartbeat", "", "id: 7", "data: first", ": keep alive", "data: second: value", "", "id: 8", "event: update", "data: next 👀", "", ""].join(newline);
    const expected = [
      { type: "message", data: "first\nsecond: value", lastEventId: "7" },
      { type: "update", data: "next 👀", lastEventId: "8" },
    ];
    for (let index = 0; index <= text.length; index++) expect(parse([text.slice(0, index), text.slice(index)])).toEqual(expected);
    expect(parse(text.split(""))).toEqual(expected);
  });

  it("waits for the blank line and ignores comments and incomplete frames", () => {
    const events: SseEvent[] = [];
    const parser = createSseParser(event => events.push(event));
    parser.push(": heartbeat\r\n\r\ndata: not yet\r");
    expect(events).toEqual([]);
    parser.push("\n");
    expect(events).toEqual([]);
    parser.push("\r");
    expect(events).toEqual([{ type: "message", data: "not yet", lastEventId: "" }]);
    parser.push("\ndata: unfinished");
    expect(events).toHaveLength(1);
    expect(parse(["data: no final blank line\n"])).toEqual([]);
    expect(parse([": heartbeat\n\n\n"])).toEqual([]);
  });

  it("persists the latest id, supports id-only frames and empty resets, and ignores ids containing null", () => {
    expect(parse(["id: 1\nid: 2\ndata: a\n\ndata: b\n\nid: 3\n\nid: bad\0id\ndata: c\n\nid:\ndata: d\n\nid\n\ndata: e\n\n"])).toEqual([
      { type: "message", data: "a", lastEventId: "2" },
      { type: "message", data: "b", lastEventId: "2" },
      { type: "message", data: "c", lastEventId: "3" },
      { type: "message", data: "d", lastEventId: "" },
      { type: "message", data: "e", lastEventId: "" },
    ]);
  });

  it("removes exactly one leading space and dispatches empty data fields", () => {
    expect(parse(["unknown: ignored\nretry: 1000\ndata:  two spaces\ndata:\ndata\ndata:\tkept\ndata:no space\n\ndata\n\n"])).toEqual([
      { type: "message", data: " two spaces\n\n\n\tkept\nno space", lastEventId: "" },
      { type: "message", data: "", lastEventId: "" },
    ]);
  });

  it("resets event types between frames and uses message for an empty event field", () => {
    expect(parse(["event: unused\n\nevent: first\nevent: update\ndata: a\n\ndata: b\n\nevent:\ndata: c\n\n"])).toEqual([
      { type: "update", data: "a", lastEventId: "" },
      { type: "message", data: "b", lastEventId: "" },
      { type: "message", data: "c", lastEventId: "" },
    ]);
  });

  it("handles mixed line endings and removes a BOM only at the start of the stream", () => {
    expect(parse(["", "\uFEFF", "id: 1\rdata: a\n\r\ndata: \uFEFFb\r\r"])).toEqual([
      { type: "message", data: "a", lastEventId: "1" },
      { type: "message", data: "\uFEFFb", lastEventId: "1" },
    ]);
  });

  it("feeds task frames into the sequencer and lets validation errors reach the caller", () => {
    const sequencer = new TaskEventSequencer(taskId);
    const accepted: number[] = [];
    const parser = createSseParser(event => {
      const taskEvent = sequencer.accept(event.lastEventId, event.data);
      if (taskEvent) accepted.push(taskEvent.seq);
    });
    const data = JSON.stringify(envelope({ kind: "assistant_text", text: "Saved." }));
    const frame = `id: 1\ndata: ${data}\n\n`;
    for (const chunk of frame.split("")) parser.push(chunk);
    parser.push(frame);
    expect(accepted).toEqual([1]);
    expect(() => parser.push(`id: 2\ndata: ${data}\n\n`)).toThrow("SSE id does not match");
    expect(sequencer.lastSeq).toBe(1);
  });
});
