import { z } from "zod";
import { AgentId, FileId, RelPath } from "@quokkabot/shared";
import type { DesktopSettings } from "@quokkabot/shared";

export const NoPayload = z.undefined();
export const SettingsPatch = z.object({
  launchAtLogin: z.boolean().optional(),
  notifications: z.boolean().optional(),
  notificationDetails: z.boolean().optional(),
}).strict().transform((input): Partial<DesktopSettings> => ({
  ...(input.launchAtLogin === undefined ? {} : { launchAtLogin: input.launchAtLogin }),
  ...(input.notifications === undefined ? {} : { notifications: input.notifications }),
  ...(input.notificationDetails === undefined ? {} : { notificationDetails: input.notificationDetails }),
}));
export const DownloadTarget = z.union([
  z.object({ fileId: FileId }).strict(),
  z.object({ agentId: AgentId, path: RelPath.refine((path) => path !== "" && path !== ".", "Choose a file, not the workspace root.") }).strict(),
]);
export const ConnectPayload = z.string().min(1).max(2048);

export { IPC } from "./channels.js";
