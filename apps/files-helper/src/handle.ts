import { createHash } from "node:crypto";
import { lstat, readdir, type FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import {
  FilesExportRequest,
  FilesRequest,
  LIMITS,
  type FileEntry,
  type FilesResult,
} from "@quokkabot/shared";
import {
  atomicWrite,
  entryFor,
  FileOperationError,
  openRegular,
  operationError,
  rootFor,
  walk,
  type FilesEnvironment,
} from "./paths.js";
import { binaryError, imageMime, isPdf, pdfPage, prefixOf, replaceText, textPage, utf8Text } from "./text.js";

export type { FilesEnvironment } from "./paths.js";

function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const offset = Number(decoded.slice(5));
  if (!/^list:[1-9][0-9]*$/.test(decoded) || !Number.isSafeInteger(offset) || Buffer.from(decoded).toString("base64url") !== cursor) {
    throw new FileOperationError("invalid", "Invalid list cursor");
  }
  return offset;
}

async function list(request: Extract<FilesRequest, { op: "list" }>, env: FilesEnvironment): Promise<FilesResult> {
  const offset = cursorOffset(request.cursor);
  const root = rootFor(request.scope, env);
  const directory = await walk(root, request.dir);
  if (!directory.stats?.isDirectory()) throw new FileOperationError("not_a_file", `Not a directory: ${request.dir}`);
  const entries: FileEntry[] = [];
  const atDownloadsRoot = request.scope === "downloads" && (request.dir === "" || request.dir === ".");
  for (const name of await readdir(directory.absolute)) {
    // The control plane's own areas: partial files before publication, and evidence copies of attached files.
    if (atDownloadsRoot && (name === ".incoming" || name === ".evidence")) continue;
    const relative = request.dir === "" || request.dir === "." ? name : `${request.dir}/${name}`;
    const stats = await lstat(`${directory.absolute}/${name}`);
    entries.push(entryFor(relative, stats, root));
  }
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === "dir" ? -1 : 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  const page: FileEntry[] = [];
  let next = offset;
  for (const entry of entries.slice(offset, offset + LIMITS.filesListEntries)) {
    const candidate = {
      op: "list" as const,
      entries: [...page, entry],
      nextCursor: next + 1 < entries.length ? Buffer.from(`list:${next + 1}`).toString("base64url") : null,
    };
    // Metadata and long paths can hit the CLI's result threshold before the entry count limit.
    if (JSON.stringify(candidate).length > LIMITS.toolResultChars) {
      if (page.length === 0) throw new FileOperationError("too_large", "One directory entry exceeds the tool result character limit");
      break;
    }
    page.push(entry);
    next += 1;
  }
  return { op: "list", entries: page, nextCursor: next < entries.length ? Buffer.from(`list:${next}`).toString("base64url") : null };
}

async function read(request: Extract<FilesRequest, { op: "read" }>, env: FilesEnvironment): Promise<FilesResult> {
  const { file, absolute } = await openRegular(rootFor(request.scope, env), request.path);
  try {
    const prefix = await prefixOf(file);
    const offset = request.offset ?? 1;
    const limit = request.limit ?? LIMITS.fileReadDefaultLines;
    if (isPdf(prefix)) {
      const page = await pdfPage(env.QB_PDFTOTEXT ?? "/usr/bin/pdftotext", absolute, offset, limit);
      return { op: "read", kind: "pdf_text", mimeType: "text/plain", ...page };
    }
    const mimeType = imageMime(prefix);
    if (mimeType !== null) {
      if ((await file.stat()).size > LIMITS.screenshotMaxBytes) throw new FileOperationError("too_large", "Image exceeds the screenshot byte limit");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
        bytes += chunk.length;
        if (bytes > LIMITS.screenshotMaxBytes) throw new FileOperationError("too_large", "Image exceeds the screenshot byte limit");
        chunks.push(chunk);
      }
      return { op: "read", kind: "image", content: Buffer.concat(chunks).toString("base64"), mimeType, totalLines: null, nextOffset: null };
    }
    if (prefix.includes(0)) throw binaryError();
    const page = await textPage(utf8Text(file.createReadStream({ start: 0, autoClose: false })), offset, limit);
    return { op: "read", kind: "text", mimeType: "text/plain", ...page };
  } finally {
    await file.close();
  }
}

async function write(request: Extract<FilesRequest, { op: "write" }>, env: FilesEnvironment): Promise<FilesResult> {
  const bytes = Buffer.from(request.content, "utf8");
  await atomicWrite(rootFor("workspace", env), request.path, (file) => file.writeFile(bytes));
  return { op: "write", bytes: bytes.length };
}

async function edit(request: Extract<FilesRequest, { op: "edit" }>, env: FilesEnvironment): Promise<FilesResult> {
  const root = rootFor("workspace", env);
  const { file } = await openRegular(root, request.path);
  try {
    const prefix = await prefixOf(file);
    if (prefix.includes(0) || imageMime(prefix) !== null || isPdf(prefix)) throw binaryError();
    let replacements = 0;
    await atomicWrite(root, request.path, async (temporary) => {
      const text = utf8Text(file.createReadStream({ start: 0, autoClose: false }));
      for await (const chunk of replaceText(text, request.oldString, request.newString, () => { replacements += 1; })) {
        await temporary.writeFile(chunk, "utf8");
      }
      if (replacements === 0) throw new FileOperationError("no_match", "The exact substring was not found");
      if (replacements > 1 && !request.replaceAll) {
        throw new FileOperationError("multiple_matches", `Found ${replacements} matches; set replaceAll to replace them all`);
      }
    });
    return { op: "edit", replacements };
  } finally {
    await file.close();
  }
}

async function copy(request: Extract<FilesRequest, { op: "copy_from_downloads" }>, env: FilesEnvironment): Promise<FilesResult> {
  const { file } = await openRegular(rootFor("downloads", env), request.source);
  try {
    return await atomicWrite(rootFor("workspace", env), request.dest, async (temporary) => {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
        await temporary.writeFile(chunk);
        hash.update(chunk);
        bytes += chunk.length;
      }
      return { op: "copy_from_downloads", bytes, sha256: hash.digest("hex") };
    });
  } finally {
    await file.close();
  }
}

async function hashFile(file: FileHandle): Promise<string | null> {
  if ((await file.stat()).size > LIMITS.downloadMaxBytes) return null;
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
    bytes += chunk.length;
    if (bytes > LIMITS.downloadMaxBytes) return null;
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function stat(request: Extract<FilesRequest, { op: "stat" }>, env: FilesEnvironment): Promise<FilesResult> {
  const root = rootFor(request.scope, env);
  const target = await walk(root, request.path);
  if (target.stats === null) throw new Error("Existing stat target has no metadata");
  if (target.stats.isDirectory()) return { op: "stat", entry: entryFor(request.path, target.stats, root), sha256: null };
  const { file } = await openRegular(root, request.path);
  try {
    const sha256 = await hashFile(file);
    return { op: "stat", entry: entryFor(request.path, await file.stat(), root), sha256 };
  } finally {
    await file.close();
  }
}

export async function handle(input: unknown, env: FilesEnvironment = process.env): Promise<FilesResult> {
  // Validation failures are programmer/input errors, not FilesResult errors. The CLI exits nonzero for them.
  const request = FilesRequest.parse(input);
  try {
    switch (request.op) {
      case "list": return await list(request, env);
      case "read": return await read(request, env);
      case "write": return await write(request, env);
      case "edit": return await edit(request, env);
      case "copy_from_downloads": return await copy(request, env);
      case "stat": return await stat(request, env);
    }
  } catch (error) {
    const result = operationError(error);
    if (result === null) throw error;
    return result;
  }
}

export async function exportFile(input: unknown, output: Writable, env: FilesEnvironment = process.env): Promise<void> {
  const request = FilesExportRequest.parse(input);
  const { file } = await openRegular(rootFor(request.scope, env), request.path);
  try {
    await pipeline(file.createReadStream({ start: 0, autoClose: false }), output);
  } finally {
    await file.close();
  }
}
