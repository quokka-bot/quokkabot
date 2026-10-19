import { app, Notification } from "electron";
import { z } from "zod";
import { ActivityPage, InboxItem } from "@quokkabot/shared";
import type { ServerClient } from "./server.js";
import type { SettingsStore } from "./settings.js";
import { activityNotices, inboxNotices, nextActivityCursor, unseenNotices } from "./notification-logic.js";
import type { Notice } from "./notification-logic.js";

export class DesktopNotifications {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly controller = new AbortController();
  private readonly visible = new Set<Notification>();
  private stopped = false;
  private running = false;

  constructor(private readonly server: ServerClient, private readonly settings: SettingsStore, private readonly navigate: (route: string) => void, private readonly connectionStatus: (connected: boolean, waiting: number | null) => void, private readonly report: (error: unknown) => void) {}

  start(): void { void this.poll(); }
  refresh(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; void this.poll(); }

  private async publish(notices: Notice[], cursor?: string): Promise<void> {
    if (this.stopped) return;
    const { fresh, seen } = unseenNotices(notices, this.settings.get().seenNotificationIds);
    // Persist IDs and the cursor together, before displaying, so a restart cannot replay old notifications.
    await this.settings.update({ seenNotificationIds: seen, ...(cursor === undefined ? {} : { activityCursor: cursor }) });
    if (this.stopped || !this.settings.get().notifications) return;
    for (const notice of fresh) {
      const notification = new Notification({ title: notice.title, body: notice.body });
      notification.on("click", () => { if (!this.stopped) this.navigate(notice.route); });
      notification.on("close", () => this.visible.delete(notification));
      this.visible.add(notification);
      notification.show();
    }
  }

  private async poll(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const init = { signal: this.controller.signal };
      const inbox = z.object({ items: z.array(InboxItem) }).parse(await this.server.json("/api/inbox", init));
      if (this.stopped) return;
      const notices = inboxNotices(inbox.items, this.settings.get().notificationDetails);
      await this.publish(notices);
      let more = true;
      // Drain a bounded number of pages per tick so a large backlog cannot monopolise main.
      for (let pageCount = 0; more && pageCount < 20 && !this.stopped; pageCount += 1) {
        const cursor = this.settings.get().activityCursor;
        const query = cursor === null ? "" : `?${new URLSearchParams({ cursor })}`;
        const page = ActivityPage.parse(await this.server.json(`/api/activity${query}`, init));
        const next = nextActivityCursor(cursor, page);
        await this.publish(activityNotices(page, this.settings.get().notificationDetails), next);
        more = page.more;
      }
      if (!this.stopped) { app.setBadgeCount(notices.length); this.connectionStatus(true, notices.length); }
    } catch (error) {
      if (!this.stopped) { this.connectionStatus(false, null); this.report(error); }
    } finally {
      this.running = false;
      if (!this.stopped) this.timer = setTimeout(() => { this.timer = null; void this.poll(); }, 10000);
    }
  }

  dispose(): void {
    this.stopped = true;
    this.controller.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    for (const notification of this.visible) notification.close();
    this.visible.clear();
    app.setBadgeCount(0);
  }
}
