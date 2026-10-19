import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { type DownloadInfo, LIMITS } from "@quokkabot/shared";
import type { Logger } from "pino";
import type { AuditLog } from "./audit.js";
import type { BrowserServiceClient, SupervisorClient } from "./clients.js";
import { type Db, maybeOne } from "./db.js";
import type { TaskEvents } from "./events.js";

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  csv: "text/csv",
  txt: "text/plain",
  xml: "application/xml",
  json: "application/json",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

export function mimeFor(name: string, head: Buffer): string {
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  const ext = name.toLowerCase().split(".").at(-1) ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

// A file name that is safe on every filesystem and shell: one path segment, no control characters, no leading dot,
// at most 120 characters with the extension kept.
export function safeFileName(suggested: string): string {
  const base = suggested.split(/[\\/]/).at(-1) ?? "";
  let name = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^[.\s-]+/, "")
    .trim();
  if (name === "") name = "download";
  if (name.length > 120) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function uniqueName(dir: string, name: string): Promise<string> {
  if (!(await exists(join(dir, name)))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
  throw new Error("no free file name");
}

// Moves completed downloads out of the browser sandbox. The browser service streams the bytes; this process hashes
// what it received and publishes it into the agent's Downloads (read-only in the tools sandbox). Nothing here ever
// opens a path inside a sandbox-writable directory.
export class FileBroker {
  private readonly busy = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly events: TaskEvents,
    private readonly log: Logger,
  ) {}

  async sweep(agentId: string, downloadsDir: string, browser: BrowserServiceClient): Promise<void> {
    if (this.busy.has(agentId)) return;
    this.busy.add(agentId);
    try {
      const { downloads } = await browser.downloads(null);
      for (const download of downloads) {
        if (download.state !== "completed") continue;
        const published = await maybeOne(this.db, "select 1 from files where download_id = $1", [download.downloadId]);
        if (published) {
          await browser.ack(download.downloadId).catch(() => undefined);
          continue;
        }
        await this.publish(agentId, downloadsDir, browser, download);
      }
    } finally {
      this.busy.delete(agentId);
    }
  }

  private async publish(agentId: string, downloadsDir: string, browser: BrowserServiceClient, download: DownloadInfo): Promise<void> {
    const incomingDir = join(downloadsDir, ".incoming");
    await mkdir(incomingDir, { recursive: true, mode: 0o755 });
    const tempPath = join(incomingDir, randomUUID());
    const res = await browser.downloadContent(download.downloadId);
    const hash = createHash("sha256");
    let bytes = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        if (bytes > LIMITS.downloadMaxBytes) {
          done(new Error(`download larger than ${LIMITS.downloadMaxBytes} bytes`));
          return;
        }
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(res.stream, meter, createWriteStream(tempPath, { flags: "wx", mode: 0o644 }));
      const fd = await open(tempPath, "r");
      await fd.sync();
      await fd.close();
      const sha256 = hash.digest("hex");
      const claimed = res.headers["x-quokkabot-sha256"];
      if (typeof claimed === "string" && claimed !== sha256) throw new Error("hash differs from the browser service's");
      if (download.totalBytes !== null && download.totalBytes !== bytes) {
        throw new Error(`size ${bytes} differs from the expected ${download.totalBytes}`);
      }
      const name = await uniqueName(downloadsDir, safeFileName(download.suggestedFilename));
      await rename(tempPath, join(downloadsDir, name));
      const run = download.runId
        ? await maybeOne<{ task_id: string }>(this.db, "select task_id from runs where id = $1", [download.runId])
        : null;
      const fileId = randomUUID();
      await this.db.query(
        `insert into files (id, agent_id, scope, download_id, name, rel_path, bytes, sha256, mime_type, source_url, task_id, run_id)
         values ($1, $2, 'downloads', $3, $4, $4, $5, $6, $7, $8, $9, $10)`,
        [fileId, agentId, download.downloadId, name, bytes, sha256, mimeFor(name, head), download.url.slice(0, 2000), run?.task_id ?? null, download.runId],
      );
      await browser.ack(download.downloadId);
      await this.audit.append(agentId, download.runId ? "agent" : "owner", "file.published", {
        fileId,
        name,
        bytes,
        sha256,
        host: safeHost(download.url),
      });
      if (run) {
        await this.events.append(this.db, run.task_id, {
          kind: "tool_result",
          tool: "download",
          status: "ok",
          summary: `Saved ${name} (${bytes} bytes, sha256 ${sha256.slice(0, 12)})`,
        });
      }
    } catch (error) {
      await rm(tempPath, { force: true });
      this.log.error({ err: String(error), downloadId: download.downloadId }, "publishing a download failed");
      throw error;
    }
  }

  // Removes leftovers from interrupted publishes.
  async cleanIncoming(downloadsDir: string): Promise<void> {
    const dir = join(downloadsDir, ".incoming");
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) await rm(join(dir, entry), { force: true });
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// Immutable copies of workspace files the agent attached as proof, kept beside its Downloads (".evidence/", hidden from
// the agent's listing) and served by file id. Written only by this process.
export class EvidenceStore {
  constructor(
    private readonly supervisor: SupervisorClient,
    private readonly downloadsDir: (agentId: string) => string,
  ) {}

  async capture(agentId: string, path: string, fileId: string): Promise<{ relPath: string; bytes: number; sha256: string; head: Buffer }> {
    const dir = join(this.downloadsDir(agentId), ".evidence");
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const relPath = `.evidence/${fileId}`;
    const target = join(this.downloadsDir(agentId), relPath);
    const res = await this.supervisor.exportFile(agentId, { scope: "workspace", path });
    const hash = createHash("sha256");
    let bytes = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        if (bytes > LIMITS.downloadMaxBytes) {
          done(new Error(`file larger than ${LIMITS.downloadMaxBytes} bytes`));
          return;
        }
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(res.stream, meter, createWriteStream(target, { flags: "wx", mode: 0o444 }));
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    return { relPath, bytes, sha256: hash.digest("hex"), head };
  }
}
