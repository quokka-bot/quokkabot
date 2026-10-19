export type SseEvent = { type: string; data: string; lastEventId: string };

// Feed decoded text chunks, keeping this parser for the lifetime of one connection. An event needs a blank line;
// an unfinished frame at the end of the connection is not dispatched. The caller decodes UTF-8 across byte chunks.
export function createSseParser(onEvent: (event: SseEvent) => void): { push(chunk: string): void } {
  let line = "";
  let skipLf = false;
  let atStart = true;
  let data: string[] = [];
  let type = "";
  let lastEventId = "";
  const acceptLine = () => {
    const current = line;
    line = "";
    if (current === "") {
      const event = { type: type || "message", data: data.join("\n"), lastEventId };
      const dispatch = data.length > 0;
      data = [];
      type = "";
      if (dispatch) onEvent(event);
      return;
    }
    if (current.startsWith(":")) return;
    const colon = current.indexOf(":");
    const field = colon === -1 ? current : current.slice(0, colon);
    const value = colon === -1 ? "" : current.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "event") type = value;
    else if (field === "id" && !value.includes("\0")) lastEventId = value;
  };
  return {
    push(chunk) {
      for (const character of chunk) {
        if (atStart) {
          atStart = false;
          if (character === "\uFEFF") continue;
        }
        if (skipLf) {
          skipLf = false;
          if (character === "\n") continue;
        }
        if (character === "\r" || character === "\n") {
          skipLf = character === "\r";
          acceptLine();
        } else line += character;
      }
    },
  };
}
