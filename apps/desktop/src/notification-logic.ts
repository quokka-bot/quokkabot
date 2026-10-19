import type { ActivityPage, InboxItem } from "@quokkabot/shared";

export interface Notice { id: string; title: string; body: string; route: string }

export function inboxNotices(items: InboxItem[], details: boolean): Notice[] {
  const notices = new Map<string, Notice>();
  for (const item of items) {
    if (item.kind === "domain_request") {
      if (item.request.decidedAt !== null || item.request.decision !== null) continue;
      const id = `domain:${item.request.id}`;
      notices.set(id, { id, title: "An agent requests a domain", body: details ? item.request.reason : "Review a domain request in Quokka Bot.", route: `/agents/${item.agentId}/domains` });
    } else {
      if (item.request.answeredAt !== null) continue;
      const id = `owner:${item.request.id}`;
      // A takeover happens in the computer view; a question and a login request are answered on the task page.
      const kind = item.request.kind;
      const title = kind === "takeover" ? "An agent needs your help" : kind === "login" ? "An agent needs a login" : kind === "connect" ? "An agent needs Gmail connected" : "An agent asks a question";
      const body = details ? (kind === "login" && item.request.site ? `Login for ${item.request.site}: ${item.request.text}` : item.request.text) : "Review the request in Quokka Bot.";
      notices.set(id, { id, title, body, route: kind === "takeover" ? `/agents/${item.agentId}/computer` : `/tasks/${item.request.taskId}` });
    }
  }
  return [...notices.values()];
}

export function activityNotices(page: ActivityPage, details: boolean): Notice[] {
  return page.items.map((item) => ({
    id: `task:${item.taskId}:${item.at}:${item.state}`,
    title: item.state === "completed" ? "Task finished" : item.state === "failed" ? "Task failed" : item.state === "cancelled" ? "Task cancelled" : "Task outcome unknown",
    body: details ? item.title : "Open Quokka Bot to see the result.", route: `/tasks/${encodeURIComponent(item.taskId)}`,
  }));
}

export function unseenNotices(notices: Notice[], seen: readonly string[]): { fresh: Notice[]; seen: string[] } {
  const ids = new Set(seen);
  const fresh: Notice[] = [];
  for (const notice of notices) {
    if (ids.has(notice.id)) continue;
    ids.add(notice.id);
    fresh.push(notice);
  }
  return { fresh, seen: [...ids].slice(-1000) };
}

export function nextActivityCursor(previous: string | null, page: ActivityPage): string {
  if (page.cursor.length === 0 || page.cursor.length > 4096) throw new Error("The activity cursor is invalid.");
  if (page.more && page.cursor === previous) throw new Error("The activity cursor did not advance while more pages remain.");
  if (previous === null && page.items.length !== 0) throw new Error("The first activity poll must start at the current position.");
  return page.cursor;
}
