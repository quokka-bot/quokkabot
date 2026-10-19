import { extname } from "node:path";

export function sanitizeDownloadName(input: string): string {
  let name = input.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\:<>"|?*]/gu, "_").replace(/^[.\s]+|[.\s]+$/gu, "");
  if (name.length === 0) name = "download";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `_${name}`;
  // Leave room for a uniqueness suffix on filesystems with a 255-byte component limit.
  const extension = extname(name);
  const preservedExtension = Buffer.byteLength(extension) <= 32 ? extension : "";
  let stem = preservedExtension ? name.slice(0, -preservedExtension.length) : name;
  while (Buffer.byteLength(stem + preservedExtension) > 200) stem = Array.from(stem).slice(0, -1).join("");
  return stem + preservedExtension;
}

export function uniqueDownloadName(name: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("Invalid download name attempt.");
  const safe = sanitizeDownloadName(name);
  if (attempt === 0) return safe;
  const extension = extname(safe);
  const stem = extension ? safe.slice(0, -extension.length) : safe;
  return `${stem} (${attempt})${extension}`;
}
