import { randomUUID } from "node:crypto";
import { Attachment, AttachmentIds, ImageMediaType, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, type RunImage } from "@quokkabot/shared";
import { sha256Hex } from "@quokkabot/shared/node";
import type { AuditLog } from "./audit.js";
import { type Db, type Tx, many, maybeOne, one } from "./db.js";
import { HttpError } from "./errors.js";
import { safeFileName } from "./files.js";

export interface AttachmentRow {
  id: string; agent_id: string; task_id: string | null; name: string; media_type: ImageMediaType;
  bytes: number; width: number; height: number; sha256: string; data: Buffer;
}
export function attachmentView(row: AttachmentRow): Attachment {
  return Attachment.parse({ id: row.id, name: row.name, mediaType: row.media_type, bytes: row.bytes, width: row.width, height: row.height });
}
function invalid(message: string): never { throw new HttpError(400, "invalid_image", message); }

// Only inspect headers. No decoder runs on owner-supplied bytes in the trusted control plane.
export function validateImage(data: Buffer, declaredType: string): { mediaType: ImageMediaType; width: number; height: number } {
  if (data.length > MAX_IMAGE_BYTES) throw new HttpError(413, "image_too_large", "Images must be at most 3.75 MB. Resize the image and try again.");
  const type = ImageMediaType.safeParse(declaredType);
  if (!type.success) throw new HttpError(415, "image_type", "Choose a PNG, JPEG, GIF or WebP image.");
  let width = 0;
  let height = 0;
  if (type.data === "image/png") {
    if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.readUInt32BE(8) !== 13 || data.toString("latin1", 12, 16) !== "IHDR") invalid("The file is not a valid PNG image.");
    width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (type.data === "image/gif") {
    if (data.length < 13 || !["GIF87a", "GIF89a"].includes(data.toString("latin1", 0, 6))) invalid("The file is not a valid GIF image.");
    width = data.readUInt16LE(6); height = data.readUInt16LE(8);
  } else if (type.data === "image/jpeg") {
    if (data.length < 4 || data[0] !== 255 || data[1] !== 216) invalid("The file is not a valid JPEG image.");
    let offset = 2;
    while (offset < data.length) {
      if (data[offset++] !== 255) invalid("Invalid JPEG header.");
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === undefined || marker === 0 || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) invalid("Truncated JPEG header.");
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) invalid("Truncated JPEG header.");
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) invalid("Invalid JPEG size header.");
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else {
    if (data.length < 20 || data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WEBP" || data.readUInt32LE(4) + 8 !== data.length) invalid("The file is not a valid WebP image.");
    const kind = data.toString("latin1", 12, 16);
    const size = data.readUInt32LE(16);
    if (size + 20 > data.length) invalid("Truncated WebP header.");
    if (kind === "VP8X" && size === 10) {
      width = data.readUIntLE(24, 3) + 1; height = data.readUIntLE(27, 3) + 1;
    } else if (kind === "VP8L" && size >= 5 && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      if ((bits >>> 29) !== 0) invalid("Invalid WebP lossless header.");
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === "VP8 " && size >= 10 && (data[20]! & 1) === 0 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff;
    } else invalid("Invalid WebP size header.");
  }
  if (width < 1 || height < 1) invalid("The image has no valid pixel size.");
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) invalid("Each image side must be at most 8000 pixels.");
  return { mediaType: type.data, width, height };
}

export async function uploadAttachment(db: Db, audit: AuditLog, agentId: string, name: string, mediaType: string, data: Buffer): Promise<Attachment> {
  if (name.length === 0 || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) invalid("Choose an image with a file name of 1 to 255 characters.");
  const image = validateImage(data, mediaType);
  await db.query("delete from attachments where task_id is null and created_at < now() - interval '24 hours'");
  const hash = sha256Hex(data);
  const row = await one<AttachmentRow>(db,
    `insert into attachments (id, agent_id, name, media_type, bytes, width, height, sha256, data)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [randomUUID(), agentId, name, image.mediaType, data.length, image.width, image.height, hash, data]);
  await audit.append(agentId, "owner", "attachment.added", { name: audit.textDigest(name), type: image.mediaType, bytes: data.length, sha256: hash });
  return attachmentView(row);
}

export async function bindAttachments(tx: Tx, agentId: string, taskId: string, ids: readonly string[]): Promise<Attachment[]> {
  const parsed = AttachmentIds.safeParse(ids);
  if (!parsed.success) throw new HttpError(400, "invalid_attachments", "Attach at most 8 images with unique, valid ids.");
  if (ids.length === 0) return [];
  const rows = await many<AttachmentRow>(tx, "select * from attachments where id = any($1::uuid[]) order by id for update", [ids]);
  if (rows.length !== ids.length || rows.some(row => row.agent_id !== agentId || row.task_id !== null)) {
    throw new HttpError(400, "invalid_attachments", "An image is missing, belongs to another agent, or has already been sent. Attach it again.");
  }
  await tx.query("update attachments set task_id = $2 where id = any($1::uuid[])", [ids, taskId]);
  return ids.map(id => attachmentView(rows.find(row => row.id === id)!));
}

export async function runAttachments(db: Db | Tx, taskId: string, ids: readonly string[]): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  const rows = await many<AttachmentRow>(db, "select * from attachments where task_id = $1 and id = any($2::uuid[])", [taskId, ids]);
  if (rows.length !== ids.length) throw new Error("Pending attachments are missing from the task");
  return ids.map(id => rows.find(row => row.id === id)!);
}
export const attachmentPath = (row: AttachmentRow): string => `attachments/${row.id.slice(0, 8)}-${safeFileName(row.name)}`;
export const runImage = (row: AttachmentRow): RunImage => ({ mediaType: row.media_type, data: row.data.toString("base64") });

export async function attachmentContent(db: Db, id: string): Promise<AttachmentRow> {
  const row = await maybeOne<AttachmentRow>(db, "select * from attachments where id = $1", [id]);
  if (!row) throw new HttpError(404, "unknown_attachment", "No such image.");
  return row;
}
export function attachmentHeaders(row: AttachmentRow): Record<string, string> {
  const filename = encodeURIComponent(row.name).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return { "content-type": row.media_type, "content-length": String(row.bytes), "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox", "content-disposition": `inline; filename*=UTF-8''${filename}`,
    "cache-control": "private, max-age=86400" };
}
