import { safeOrigin } from "./policy.js";

export function updateFeed(origin: string): string { return new URL("/desktop/", origin).href; }
export function validateUpdateFiles(info: { files: readonly { url: string }[]; path?: string }, origin: string): void {
  if (info.files.length === 0) throw new Error("The update feed contains no files.");
  for (const file of [...info.files, ...(info.path === undefined ? [] : [{ url: info.path }])]) {
    const url = new URL(file.url, updateFeed(origin));
    if (safeOrigin(url.href) !== origin || !url.pathname.startsWith("/desktop/")) throw new Error("An update file is outside this server's desktop feed.");
  }
}
