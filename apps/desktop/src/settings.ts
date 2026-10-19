import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { DesktopSettings } from "@quokkabot/shared";
import { validateServerPair } from "./origins.js";

export const WindowBounds = z.object({
  x: z.number().int().optional(), y: z.number().int().optional(),
  width: z.number().int().min(900).max(16384), height: z.number().int().min(600).max(16384),
}).strict();
export const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  serverOrigin: z.string().nullable().default(null), viewOrigin: z.string().nullable().default(null),
  launchAtLogin: z.boolean().default(false), notifications: z.boolean().default(true), notificationDetails: z.boolean().default(true),
  downloadDir: z.string().min(1),
  seenNotificationIds: z.array(z.string().min(1).max(1024)).max(1000).default([]),
  activityCursor: z.string().min(1).max(4096).nullable().default(null),
  bounds: WindowBounds.default({ width: 1280, height: 860 }),
}).strict().superRefine((value, context) => {
  if ((value.serverOrigin === null) !== (value.viewOrigin === null)) context.addIssue({ code: "custom", message: "Both server origins must be configured together." });
  if (value.serverOrigin !== null && value.viewOrigin !== null) {
    try {
      const canonical = validateServerPair(value.serverOrigin, value.viewOrigin);
      if (canonical.serverOrigin !== value.serverOrigin || canonical.viewOrigin !== value.viewOrigin) throw new Error("Stored server origins must be canonical, without trailing slashes.");
    }
    catch (error) { context.addIssue({ code: "custom", message: String(error) }); }
  }
  if (!value.downloadDir.startsWith("/")) context.addIssue({ code: "custom", message: "The download directory must be absolute." });
});
export type StoredSettings = z.infer<typeof SettingsSchema>;

export function parseSettings(value: unknown, defaultDownloadDir: string): StoredSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Settings must be a JSON object.");
  return SettingsSchema.parse({ downloadDir: defaultDownloadDir, ...value });
}
export function publicSettings(value: StoredSettings): DesktopSettings {
  return { launchAtLogin: value.launchAtLogin, notifications: value.notifications, notificationDetails: value.notificationDetails };
}

export class SettingsStore {
  private tail: Promise<void> = Promise.resolve();
  private constructor(readonly filename: string, private value: StoredSettings) {}

  static async load(filename: string, defaultDownloadDir: string): Promise<SettingsStore> {
    let value: unknown;
    try { value = JSON.parse(await readFile(filename, "utf8")) as unknown; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error(`Cannot read desktop settings: ${String(error)}`);
      value = {};
    }
    const store = new SettingsStore(filename, parseSettings(value, defaultDownloadDir));
    await store.update({});
    return store;
  }

  get(): StoredSettings { return structuredClone(this.value); }

  update(patch: Partial<StoredSettings>): Promise<StoredSettings> {
    const operation = this.tail.then(async () => {
      const next = SettingsSchema.parse({ ...this.value, ...patch });
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.filename);
      this.value = next;
      return this.get();
    });
    // A failed write is reported to its caller, but must not permanently poison the write queue.
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async flush(): Promise<void> { await this.tail; }
}
