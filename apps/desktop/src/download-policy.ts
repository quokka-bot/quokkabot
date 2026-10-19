import type { DesktopDownloadTarget } from "@quokkabot/shared";
import { DownloadTarget } from "./schemas.js";

export function downloadApiPath(input: DesktopDownloadTarget): string {
  const target = DownloadTarget.parse(input);
  return "fileId" in target ? `/api/files/${target.fileId}/content` : `/api/agents/${target.agentId}/workspace-file?${new URLSearchParams({ path: target.path })}`;
}

export function contentFilename(header: string | null, fallback: string): string {
  if (header === null) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header)?.[1];
  if (encoded !== undefined) {
    try { return decodeURIComponent(encoded.trim()); } catch { throw new Error("The server returned a malformed encoded download filename."); }
  }
  const quoted = /filename="((?:[^"\\]|\\.)*)"/iu.exec(header)?.[1];
  if (quoted !== undefined) return quoted.replace(/\\(.)/gu, "$1");
  return /filename=([^;]+)/iu.exec(header)?.[1]?.trim() ?? fallback;
}

