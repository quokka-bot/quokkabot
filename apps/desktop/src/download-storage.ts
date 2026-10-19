import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { uniqueDownloadName } from "./download-names.js";

export function reserveDownload(directory: string, filename: string): { path: string; name: string } {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const name = uniqueDownloadName(filename, attempt);
    const path = join(directory, name);
    try { closeSync(openSync(path, "wx", 0o600)); return { path, name }; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  throw new Error("Cannot choose an unused download filename after 10000 attempts.");
}

