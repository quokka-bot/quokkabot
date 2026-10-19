import { constants } from "node:fs";
import { open, mkdir, lstat, rename, unlink, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { z } from "zod";
import { RunOutputLine, RunStatus } from "@quokkabot/shared";

export function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

export async function directory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing non-directory data path: ${path}`);
  if (created !== undefined) await syncDirectory(dirname(path));
}

export async function requireDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Refusing non-directory data path: ${path}`);
}

export async function emptyDirectory(path: string): Promise<void> {
  await requireDirectory(path);
  // The sandboxes have been removed and the agent parent is host-owned, so no process can swap these paths.
  // rm unlinks symlinks themselves and never traverses their targets. Preserve the root's inode and metadata.
  for (const name of await readdir(path)) await rm(join(path, name), { recursive: true, force: true });
  await syncDirectory(path);
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWrite(path: string, contents: string, owner?: (path: string) => Promise<void>): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents);
    if (owner) await owner(temporary);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function durableRemove(path: string): Promise<void> {
  try { await unlink(path); } catch (error) { if (!isMissing(error)) throw error; }
  await syncDirectory(dirname(path));
}

const StoredRun = z.object({ status: RunStatus, execId: z.string().nullable(), cancelRequested: z.boolean() }).strict();
export type StoredRun = z.infer<typeof StoredRun>;

export class RunStore {
  readonly records = new Map<string, StoredRun>();
  private readonly events = new EventEmitter();
  private readonly writes = new Map<string, Promise<void>>();
  constructor(readonly root: string) { this.events.setMaxListeners(1000); }

  async load(): Promise<void> {
    await directory(this.root);
    for (const name of await readdir(this.root)) {
      if (name.startsWith(".export-") || name.endsWith(".tmp")) { await rm(join(this.root, name), { recursive: true, force: true }); continue; }
      if (!name.endsWith(".json")) continue;
      const record = StoredRun.parse(JSON.parse(await readFile(join(this.root, name), "utf8")));
      if (name !== `${record.status.runId}.json`) throw new Error(`Run status filename mismatch: ${name}`);
      let count = 0;
      for await (const line of this.output(record.status.runId, 0)) {
        if (line.n !== count) throw new Error(`Non-sequential run output: ${name}`);
        count++;
      }
      // Output is fsynced before status. Recover a batch whose status rename was interrupted.
      if (count < record.status.lines) throw new Error(`Run output is missing durable lines: ${name}`);
      record.status.lines = count;
      this.records.set(record.status.runId, record);
    }
    // Cleanup removes status first. A restart between the two unlinks must finish deleting the raw output.
    for (const name of await readdir(this.root)) {
      if (name.endsWith(".ndjson") && !this.records.has(name.slice(0, -7))) await durableRemove(join(this.root, name));
    }
  }

  async save(record: StoredRun): Promise<void> {
    return this.writeStatus(record);
  }

  async updateStatus(record: StoredRun, patch: Partial<RunStatus>): Promise<void> {
    return this.writeStatus(record, patch);
  }

  async remove(runId: string): Promise<void> {
    const previous = this.writes.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await durableRemove(join(this.root, `${runId}.json`));
      await durableRemove(join(this.root, `${runId}.ndjson`));
      this.records.delete(runId);
      this.events.emit(runId);
    });
    this.writes.set(runId, current);
    try { await current; } finally { if (this.writes.get(runId) === current) this.writes.delete(runId); }
  }

  private async writeStatus(record: StoredRun, patch?: Partial<RunStatus>): Promise<void> {
    const id = record.status.runId;
    const previous = this.writes.get(id) ?? Promise.resolve();
    // Cancellation, output and exit can arrive together. Serialize renames and take the snapshot at write time.
    const current = previous.catch(() => undefined).then(async () => {
      const status = { ...record.status, ...patch };
      await atomicWrite(join(this.root, `${id}.json`), JSON.stringify({ ...record, status }));
      record.status = status;
      this.records.set(id, record);
      this.events.emit(id);
    });
    this.writes.set(id, current);
    try { await current; } finally { if (this.writes.get(id) === current) this.writes.delete(id); }
  }

  async reserve(record: StoredRun): Promise<void> {
    const path = join(this.root, `${record.status.runId}.json`);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(this.root);
    this.records.set(record.status.runId, record);
  }

  async append(record: StoredRun, lines: Array<{ stream: "stdout" | "stderr"; line: string }>): Promise<void> {
    if (lines.length === 0) return;
    const items = lines.map((line, offset) => ({ n: record.status.lines + offset, ...line }));
    const handle = await open(join(this.root, `${record.status.runId}.ndjson`), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(items.map((item) => JSON.stringify(item)).join("\n") + "\n"); await handle.sync(); } finally { await handle.close(); }
    await this.updateStatus(record, { lines: record.status.lines + items.length, lastOutputAt: new Date().toISOString() });
  }

  async *output(runId: string, from: number, maximum = Infinity): AsyncGenerator<RunOutputLine> {
    if (maximum <= from) return;
    let handle;
    try { handle = await open(join(this.root, `${runId}.ndjson`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (isMissing(error)) return; throw error; }
    const stream = handle.createReadStream();
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      let count = 0;
      for await (const line of lines) {
        if (count >= maximum) break;
        const parsed = RunOutputLine.parse(JSON.parse(line));
        count++;
        if (parsed.n >= from) yield parsed;
      }
    } finally { lines.close(); stream.destroy(); await handle.close(); }
  }

  async wait(record: StoredRun, from: number, seconds: number, signal: AbortSignal): Promise<void> {
    if (record.status.lines > from || !["starting", "running"].includes(record.status.state) || seconds === 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); this.events.off(record.status.runId, changed); signal.removeEventListener("abort", finish); resolve(); };
      const changed = () => { if (record.status.lines > from || !["starting", "running"].includes(record.status.state)) finish(); };
      const timer = setTimeout(finish, seconds * 1000);
      this.events.on(record.status.runId, changed);
      signal.addEventListener("abort", finish, { once: true });
      changed();
    });
  }
}
