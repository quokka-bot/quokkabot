import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { LIMITS } from "@quokkabot/shared";
import { FileOperationError } from "./paths.js";

const PDF_TIMEOUT_MS = 30_000;
const STDERR_CHARS = 4_000;

export async function prefixOf(file: FileHandle): Promise<Buffer> {
  const prefix = Buffer.alloc(8192);
  let used = 0;
  while (used < prefix.length) {
    const { bytesRead } = await file.read(prefix, used, prefix.length - used, used);
    if (bytesRead === 0) break;
    used += bytesRead;
  }
  return prefix.subarray(0, used);
}

export function imageMime(prefix: Buffer): string | null {
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return "image/jpeg";
  const signature = prefix.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export function isPdf(prefix: Buffer): boolean {
  return prefix.subarray(0, 5).equals(Buffer.from("%PDF-"));
}

export function binaryError(): FileOperationError {
  return new FileOperationError("not_a_file", "binary file; use workspace_exec to convert it");
}

export async function* utf8Text(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for await (const chunk of bytes) {
    let text: string;
    try {
      text = decoder.decode(chunk, { stream: true });
    } catch {
      throw binaryError();
    }
    if (text.length > 0) yield text;
  }
  let final: string;
  try {
    final = decoder.decode();
  } catch {
    throw binaryError();
  }
  if (final.length > 0) yield final;
}

export interface TextPage {
  content: string;
  totalLines: number;
  nextOffset: number | null;
}

export async function textPage(text: AsyncIterable<string>, offset: number, limit: number): Promise<TextPage> {
  let totalLines = 0;
  let includedLines = 0;
  let content = "";
  let pendingLine = "";
  let pendingLength = 0;
  let stopped = false;
  let nextOffset: number | null = null;

  function appendPart(part: string): void {
    pendingLength += part.length;
    // Keep scanning after the page fills so totalLines and UTF-8 validation cover the whole file.
    if (!stopped && totalLines + 1 >= offset && pendingLength <= LIMITS.fileReadChars) pendingLine += part;
  }

  function finishLine(terminated: boolean): void {
    totalLines += 1;
    if (!stopped && totalLines >= offset) {
      const prefix = `${String(totalLines).padStart(6, " ")}\t`;
      const length = prefix.length + pendingLength + (terminated ? 1 : 0);
      if (includedLines >= limit || content.length + length > LIMITS.fileReadChars) {
        if (includedLines === 0) {
          throw new FileOperationError("too_large", `Line ${totalLines} exceeds the text page character limit; use workspace_exec to convert it`);
        }
        nextOffset = totalLines;
        stopped = true;
      } else {
        content += prefix + pendingLine + (terminated ? "\n" : "");
        includedLines += 1;
      }
    }
    pendingLine = "";
    pendingLength = 0;
  }

  for await (const chunk of text) {
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf("\n", start)) !== -1) {
      appendPart(chunk.slice(start, newline));
      finishLine(true);
      start = newline + 1;
    }
    appendPart(chunk.slice(start));
  }
  if (pendingLength > 0) finishLine(false);
  return { content, totalLines, nextOffset };
}

export async function pdfPage(executable: string, path: string, offset: number, limit: number): Promise<TextPage> {
  if (executable.length === 0) throw new FileOperationError("invalid", "QB_PDFTOTEXT must not be empty");
  const child = spawn(executable, ["-layout", "-enc", "UTF-8", path, "-"], { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, STDERR_CHARS); });
  let spawnError: Error | null = null;
  let timedOut = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code, signal) => { resolve({ code, signal }); });
  });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, PDF_TIMEOUT_MS);
  try {
    const page = await textPage(utf8Text(child.stdout), offset, limit);
    const exit = await closed;
    if (spawnError !== null) throw new FileOperationError("refused", `Unable to run pdftotext: ${(spawnError as Error).message}`);
    if (timedOut) throw new FileOperationError("refused", "pdftotext timed out after 30 seconds");
    if (exit.code !== 0) {
      throw new FileOperationError("not_a_file", `pdftotext failed (${exit.code ?? exit.signal}): ${stderr.trim()}`);
    }
    return page;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

export async function* replaceText(
  text: AsyncIterable<string>,
  oldString: string,
  newString: string,
  matched: () => void,
): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of text) {
    pending += chunk;
    let match: number;
    while ((match = pending.indexOf(oldString)) !== -1) {
      yield pending.slice(0, match) + newString;
      matched();
      pending = pending.slice(match + oldString.length);
    }
    let flush = Math.max(0, pending.length - oldString.length + 1);
    // Keep a surrogate pair together when encoding each emitted chunk to UTF-8.
    const previous = pending.charCodeAt(flush - 1);
    const next = pending.charCodeAt(flush);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) flush -= 1;
    if (flush > 0) {
      yield pending.slice(0, flush);
      pending = pending.slice(flush);
    }
  }
  if (pending.length > 0) yield pending;
}
