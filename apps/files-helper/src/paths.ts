import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FileEntry, FilesResult } from "@quokkabot/shared";

type ErrorCode = Extract<FilesResult, { op: "error" }>["code"];

export class FileOperationError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "FileOperationError";
  }
}

export interface FilesEnvironment {
  QB_WORKSPACE?: string;
  QB_DOWNLOADS?: string;
  QB_PDFTOTEXT?: string;
}

export function rootFor(scope: "workspace" | "downloads", env: FilesEnvironment): string {
  const configured = scope === "workspace" ? env.QB_WORKSPACE : env.QB_DOWNLOADS;
  const root = configured ?? (scope === "workspace" ? "/workspace" : "/downloads");
  if (root.length === 0 || !isAbsolute(root) || root.includes("\0")) {
    throw new FileOperationError("invalid", `The ${scope} root must be a nonempty absolute path`);
  }
  return resolve(root);
}

export function checkType(stats: Stats, path: string): void {
  if (stats.isSymbolicLink()) {
    throw new FileOperationError("refused", `Symlinks are refused: ${path}`);
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new FileOperationError("refused", `Special files are refused: ${path}`);
  }
  // A second name outside this root would make the file's provenance ambiguous.
  if (stats.isFile() && stats.nlink !== 1) {
    throw new FileOperationError("refused", `Hard-linked files are refused: ${path}`);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

interface WalkResult {
  absolute: string;
  stats: Stats | null;
}

export async function walk(root: string, relative: string, createParents = false): Promise<WalkResult> {
  const rootStats = await lstat(root);
  checkType(rootStats, root);
  if (!rootStats.isDirectory()) throw new FileOperationError("refused", `Root is not a directory: ${root}`);
  const segments = relative === "" || relative === "." ? [] : relative.split("/");
  let absolute = root;
  let stats: Stats | null = rootStats;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) throw new Error("Path segment unexpectedly missing");
    absolute = join(absolute, segment);
    const final = index === segments.length - 1;
    try {
      stats = await lstat(absolute);
    } catch (error) {
      if (!hasCode(error, "ENOENT") || !createParents) throw error;
      if (final) return { absolute, stats: null };
      try {
        await mkdir(absolute, { mode: 0o700 });
      } catch (mkdirError) {
        if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
      }
      stats = await lstat(absolute);
    }
    checkType(stats, absolute);
    if (!final && !stats.isDirectory()) {
      throw new FileOperationError("not_a_file", `Parent is not a directory: ${absolute}`);
    }
  }
  return { absolute, stats };
}

export async function openRegular(root: string, relative: string): Promise<{ file: FileHandle; absolute: string }> {
  const target = await walk(root, relative);
  if (!target.stats?.isFile()) throw new FileOperationError("not_a_file", `Not a regular file: ${relative}`);
  // NONBLOCK prevents a raced-in FIFO from hanging before fstat can reject it.
  const file = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    checkType(stats, relative);
    if (!stats.isFile()) throw new FileOperationError("not_a_file", `Not a regular file: ${relative}`);
    return { file, absolute: target.absolute };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export function entryFor(relative: string, stats: Stats, root: string): FileEntry {
  checkType(stats, relative);
  return {
    name: basename(relative === "" || relative === "." ? root : relative),
    path: relative === "." ? "" : relative,
    type: stats.isDirectory() ? "dir" : "file",
    bytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

export async function atomicWrite<T>(
  root: string,
  relative: string,
  write: (file: FileHandle) => Promise<T>,
): Promise<T> {
  if (relative === "" || relative === ".") throw new FileOperationError("not_a_file", "Cannot overwrite the root directory");
  const target = await walk(root, relative, true);
  if (target.stats !== null && !target.stats.isFile()) {
    throw new FileOperationError("not_a_file", `Not a regular file: ${relative}`);
  }
  const temporary = join(dirname(target.absolute), `.qb-files-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    const result = await write(file);
    await file.sync();
    await file.close();
    // Check again after writing, rather than replacing a newly introduced symlink.
    const current = await walk(root, relative, true);
    if (current.stats !== null && !current.stats.isFile()) {
      throw new FileOperationError("not_a_file", `Not a regular file: ${relative}`);
    }
    await rename(temporary, target.absolute);
    renamed = true;
    const directory = await open(dirname(target.absolute), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return result;
  } finally {
    await file.close();
    if (!renamed) await unlink(temporary);
  }
}

export function operationError(error: unknown): FilesResult | null {
  if (error instanceof FileOperationError) return { op: "error", code: error.code, message: error.message };
  if (!(error instanceof Error) || !("code" in error)) return null;
  switch (error.code) {
    case "ENOENT": return { op: "error", code: "not_found", message: error.message };
    case "ENOTDIR":
    case "EISDIR": return { op: "error", code: "not_a_file", message: error.message };
    case "EACCES":
    case "EPERM":
    case "ELOOP": return { op: "error", code: "refused", message: error.message };
    case "ENAMETOOLONG": return { op: "error", code: "invalid", message: error.message };
    default: return null;
  }
}
