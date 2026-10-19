import type { Attachment, DomainDecision, DomainRequestView, OwnerRequest, TaskEventEnvelope } from "@quokkabot/shared";
import { streamRows } from "./task-stream.js";

export type ChatItem =
  | { kind: "owner"; key: string; seq: number; text: string; at: string; attachments: Attachment[] }
  | { kind: "agent"; key: string; seq: number | null; text: string; live: boolean }
  | { kind: "steps"; key: string; lines: StepLine[] }
  | { kind: "request"; key: string; seq: number; request: OwnerRequest }
  | { kind: "domain"; key: string; seq: number; at: string; requestId: DomainRequestView["id"]; domains: string[]; reason: string; decision: DomainDecision | null }
  | { kind: "notice"; key: string; text: string; tone: "info" | "error" };

// A step is a tool the agent used, or a line it wrote between tools ("Found the report. Opening it.").
export type StepLine = { kind: "tool" | "note"; text: string };

// Each run shows one answer: text the agent wrote and then kept working after is narration, and folds into the steps
// with the tools around it. The run's last text stays a message; if a run's every text was followed by work, its last
// one is shown as the message when the run ends.
export function chatItems(events: readonly TaskEventEnvelope[]): ChatItem[] {
  const items: ChatItem[] = [];
  let pending: Extract<ChatItem, { kind: "agent" }> | null = null;
  let runAnswered = false;
  let lastNote: { steps: Extract<ChatItem, { kind: "steps" }>; line: StepLine; message: Extract<ChatItem, { kind: "agent" }> } | null = null;
  const settle = () => {
    if (pending) runAnswered = true;
    pending = null;
  };
  for (const row of streamRows(events)) {
    if (row.kind === "text") {
      if (row.text.trim()) {
        pending = { kind: "agent", key: `t${row.key}`, seq: row.finalSeq, text: row.text, live: row.live };
        items.push(pending);
      }
      continue;
    }
    const event = row.envelope.event;
    const key = `e${row.key}`;
    switch (event.kind) {
      case "owner_message": settle(); items.push({ kind: "owner", key, seq: row.envelope.seq, text: event.text, at: row.envelope.at, attachments: event.attachments }); break;
      case "tool_call":
      case "tool_result": {
        if (pending) {
          const message = pending;
          const at = items.indexOf(message);
          const before = items[at - 1];
          const line: StepLine = { kind: "note", text: message.text.trim() };
          if (before?.kind === "steps") { items.splice(at, 1); before.lines.push(line); lastNote = { steps: before, line, message }; }
          else { const steps: ChatItem = { kind: "steps", key: `s${message.key}`, lines: [line] }; items.splice(at, 1, steps); lastNote = { steps, line, message }; }
          pending = null;
        }
        const text = event.kind === "tool_call" ? `${event.tool}${event.summary ? ` · ${event.summary}` : ""}` : `${event.tool} · ${event.status}${event.summary ? ` · ${event.summary}` : ""}`;
        const last = items.at(-1);
        if (last?.kind === "steps") last.lines.push({ kind: "tool", text });
        else items.push({ kind: "steps", key, lines: [{ kind: "tool", text }] });
        break;
      }
      case "run":
        if (event.run.state === "starting") {
          settle();
          runAnswered = false;
          lastNote = null;
        } else if (event.run.state !== "running") {
          settle();
          // The run ended on work, not on words: its last line is the answer the owner gets.
          if (!runAnswered && lastNote) {
            const { steps, line, message } = lastNote;
            steps.lines.splice(steps.lines.indexOf(line), 1);
            if (steps.lines.length === 0) items.splice(items.indexOf(steps), 1);
            items.push(message);
            runAnswered = true;
          }
          lastNote = null;
        }
        break;
      case "owner_request": items.push({ kind: "request", key, seq: row.envelope.seq, request: event.request }); break;
      case "domain_request":
        items.push({ kind: "domain", key, seq: row.envelope.seq, at: row.envelope.at, requestId: event.requestId, domains: event.domains, reason: event.reason, decision: null });
        break;
      case "domain_decided": {
        const asked = items.find(item => item.kind === "domain" && item.requestId === event.requestId);
        if (asked?.kind === "domain") asked.decision = event.decision;
        break;
      }
      case "state":
        if (event.state !== "running") settle();
        if (event.state === "completed") items.push({ kind: "notice", key, text: "Done", tone: "info" });
        else if (event.state === "cancelled") items.push({ kind: "notice", key, text: "Cancelled", tone: "info" });
        // A failed task's reason is shown once, from the task itself, at the end of the chat.
        break;
      case "error":
        settle();
        if (!items.some(item => (item.kind === "agent" || item.kind === "notice") && item.text.trim() === event.message.trim())) items.push({ kind: "notice", key, text: event.message, tone: "info" });
        break;
      default: break;
    }
  }
  return items;
}

// What the agent is doing right now, in words, from its latest tool call.
export function describeStep(line: string | undefined): string {
  if (!line) return "Making progress";
  const tool = line.split(" ")[0] ?? "";
  const url = /url: (https?:\/\/[^;)\s]+)/.exec(line)?.[1];
  const host = url ? (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; } })() : null;
  switch (tool) {
    case "browser_open": case "browser_navigate": return host ? `Opening ${host}` : "Opening a page";
    case "browser_snapshot": case "browser_tabs": return "Reading the page";
    case "browser_screenshot": return "Looking at the page";
    case "browser_click": return "Clicking around";
    case "browser_type": case "browser_select": case "browser_check": case "browser_press": return "Typing";
    case "browser_scroll": return "Looking around";
    case "browser_wait": return "Waiting for the page";
    case "browser_download": case "download_status": return "Downloading";
    case "browser_fill_login": case "browser_fill_code": case "logins_list": return "Signing in";
    case "files_list": case "files_read": case "files_write": case "files_edit": case "files_copy_to_workspace": return "Working on files";
    case "workspace_exec": return "Running a command";
    case "attach_result": return "Attaching the results";
    case "request_domains": case "request_login": case "request_takeover": case "ask_owner": return "Asking you";
    default: return "Making progress";
  }
}

export function workingStatus(lines: readonly StepLine[]): string {
  const lastNote = lines.findLast(line => line.kind === "note")?.text;
  const lastStep = lines.findLast(line => line.kind === "tool" && !/ · (ok|failed|blocked|invalid|outcome_unknown)( · |$)/.test(line.text))?.text;
  return lastNote ?? describeStep(lastStep);
}

// "Today 8:16 PM" above a message that starts a new stretch of conversation.
export function timeLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
export function askedLine(request: OwnerRequest): string {
  switch (request.kind) {
    case "login": return `Asked for a login to ${request.site ?? "a site"}`;
    case "connect": return "Asked to connect Gmail";
    case "takeover": return "Asked you to take over the browser";
    case "question": return request.text;
  }
}

export function sitesLine(decision: DomainDecision | null, sites: string): string {
  switch (decision) {
    case "allow_task": return `Allowed ${sites} for this task`;
    case "allow_always": return `Allowed ${sites}`;
    case "refuse": return `Refused ${sites}`;
    case "skip": return `Skipped access to ${sites}`;
    case null: return `Access to ${sites} was not decided`;
  }
}

