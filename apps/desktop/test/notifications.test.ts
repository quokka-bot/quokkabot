import { describe, expect, it } from "vitest";
import { InboxItem } from "@quokkabot/shared";
import { activityNotices, inboxNotices, nextActivityCursor, unseenNotices } from "../src/notification-logic.js";

const id = "d1e742f7-406f-4e68-a596-a8e97801e24e";
const request = { id, taskId: id, runId: id, kind: "question", text: "Secret question", whatToDo: null, site: null, loginName: null, loginId: null, connector: null, createdAt: "2026-10-17T12:00:00Z", answeredAt: null, answer: null };
const question = InboxItem.parse({ kind: "owner_request", agentId: id, taskTitle: "Invoice", request });
const domain = InboxItem.parse({ kind: "domain_request", agentId: id, taskTitle: null, request: { id, taskId: id, domains: ["example.com"], reason: "Secret reason", createdAt: request.createdAt, decidedAt: null, decision: null } });

describe("notifications and activity cursors", () => {
  it("counts distinct waiting items, routes questions, takeovers and domains, and hides detail", () => {
    const takeover = InboxItem.parse({ kind: "owner_request", agentId: id, taskTitle: "Invoice", request: { ...request, id: "85d01291-1209-421e-9c6f-6c3567e4ad8b", kind: "takeover" } });
    const answered = InboxItem.parse({ kind: "owner_request", agentId: id, taskTitle: "Invoice", request: { ...request, answeredAt: request.createdAt } });
    const notices = inboxNotices([question, question, domain, takeover, answered], false);
    expect(notices).toHaveLength(3);
    expect(notices.map((notice) => notice.route)).toEqual([`/tasks/${id}`, `/agents/${id}/domains`, `/agents/${id}/computer`]);
    expect(JSON.stringify(notices)).not.toContain("Secret");
    expect(inboxNotices([question], true)[0]?.body).toBe("Secret question");
  });
  it("sends a login request to its task, where the login form is", () => {
    const login = InboxItem.parse({ kind: "owner_request", agentId: id, taskTitle: "Invoice", request: { ...request, kind: "login", site: "roblox.com", loginName: "Roblox" } });
    const [notice] = inboxNotices([login], true);
    expect(notice).toMatchObject({ title: "An agent needs a login", route: `/tasks/${id}` });
    expect(notice?.body).toContain("roblox.com");
  });
  it("deduplicates stable IDs and retains at most the last 1000", () => {
    const notices = inboxNotices([question, domain], true);
    const first = unseenNotices(notices, []);
    expect(first.fresh).toHaveLength(2);
    expect(unseenNotices(notices, first.seen).fresh).toEqual([]);
    const bounded = unseenNotices(notices, Array.from({ length: 1000 }, (_, i) => `old:${i}`));
    expect(bounded.seen).toHaveLength(1000);
    expect(bounded.seen.at(-1)).toBe(`domain:${id}`);
  });
  it("starts at the current position, preserves opaque cursors and rejects stalled pagination", () => {
    const initial = { items: [], cursor: "opaque|head", more: false };
    expect(nextActivityCursor(null, initial)).toBe("opaque|head");
    expect(nextActivityCursor("opaque|head", initial)).toBe("opaque|head");
    expect(() => nextActivityCursor("opaque|head", { ...initial, more: true })).toThrow(/advance/u);
    expect(() => nextActivityCursor(null, { ...initial, cursor: "" })).toThrow();
    const page = { items: [{ taskId: id, agentId: id, title: "Secret result", state: "completed" as const, at: request.createdAt }], cursor: "next|opaque", more: false };
    expect(nextActivityCursor(initial.cursor, page)).toBe(page.cursor);
    expect(() => nextActivityCursor(null, page)).toThrow(/current position/u);
    expect(activityNotices(page, false)[0]?.route).toBe(`/tasks/${id}`);
    expect(activityNotices(page, false)[0]?.body).not.toContain("Secret");
    expect(unseenNotices(activityNotices(page, true), []).fresh).toHaveLength(1);
  });
});
