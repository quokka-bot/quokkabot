import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { AttachmentIds, CreateTaskRequest, MAX_IMAGE_BYTES, ReplyRequest, claudeTaskArgv, claudeUserMessage } from "@quokkabot/shared";
import { sha256Hex } from "@quokkabot/shared/node";
import { attachmentHeaders, bindAttachments, validateImage, type AttachmentRow } from "../src/attachments.js";
import { buildServer, type HttpDeps } from "../src/http.js";
import { HttpError } from "../src/errors.js";
import type { Db, Tx } from "../src/db.js";
import { TaskService, type TaskRow, type RunRow, type OwnerRequestRow } from "../src/tasks.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const attachmentId = "33333333-3333-4333-8333-333333333333";
const otherAgent = "44444444-4444-4444-8444-444444444444";
const nineIds = Array.from({ length: 9 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64");
function gif(width = 2, height = 3): Buffer {
  const data = Buffer.alloc(13); data.write("GIF89a"); data.writeUInt16LE(width, 6); data.writeUInt16LE(height, 8); return data;
}
function jpeg(marker = 0xc0): Buffer { return Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, marker, 0, 11, 8, 0, 3, 0, 2, 1, 1, 17, 0]); }
function webp(kind: "VP8 " | "VP8L" | "VP8X"): Buffer {
  const data = Buffer.alloc(30); data.write("RIFF"); data.writeUInt32LE(22, 4); data.write("WEBP", 8); data.write(kind, 12); data.writeUInt32LE(kind === "VP8L" ? 5 : 10, 16);
  if (kind === "VP8X") { data.writeUIntLE(1, 24, 3); data.writeUIntLE(2, 27, 3); }
  else if (kind === "VP8L") { data[20] = 0x2f; data.writeUInt32LE(1 | (2 << 14), 21); }
  else { data[23] = 0x9d; data[24] = 1; data[25] = 0x2a; data.writeUInt16LE(2, 26); data.writeUInt16LE(3, 28); }
  return data;
}
const row = (): AttachmentRow => ({ id: attachmentId, agent_id: agentId, task_id: null, name: "photo 'é.png", media_type: "image/png", bytes: png.length, width: 1, height: 1, sha256: sha256Hex(png), data: png });

describe("owner image validation", () => {
  it.each([["image/png", png, 1, 1], ["image/jpeg", jpeg(), 2, 3], ["image/jpeg", jpeg(0xc2), 2, 3], ["image/gif", gif(), 2, 3], ...(["VP8 ", "VP8L", "VP8X"] as const).map(kind => ["image/webp", webp(kind), 2, 3])])("reads %s dimensions", (type, data, width, height) => {
    expect(validateImage(data as Buffer, type as string)).toEqual({ mediaType: type, width, height });
  });
  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])("rejects mismatched, truncated and oversized %s", type => {
    expect(() => validateImage(Buffer.from("not an image"), type)).toThrow();
    expect(() => validateImage(Buffer.alloc(MAX_IMAGE_BYTES + 1), type)).toThrow("3.75 MB");
    const data = type === "image/png" ? png : type === "image/gif" ? gif() : type === "image/jpeg" ? jpeg() : webp("VP8X");
    expect(() => validateImage(data.subarray(0, data.length < 40 ? 8 : 25), type)).toThrow();
  });
  it("rejects SVG, disguised magic bytes, zero and excessive pixel sizes", () => {
    expect(() => validateImage(Buffer.from("<svg/>"), "image/svg+xml")).toThrow("PNG, JPEG");
    expect(() => validateImage(gif(), "image/png")).toThrow("PNG");
    expect(() => validateImage(gif(0), "image/gif")).toThrow("pixel size");
    expect(() => validateImage(gif(8001), "image/gif")).toThrow("8000");
    const highBits = gif(); highBits[0] = 0xc7;
    expect(() => validateImage(highBits, "image/gif")).toThrow();
    const bigPng = Buffer.from(png); bigPng.writeUInt32BE(8001, 16);
    expect(() => validateImage(bigPng, "image/png")).toThrow("8000");
    const bigJpeg = jpeg(); bigJpeg.writeUInt16BE(8001, 15);
    expect(() => validateImage(bigJpeg, "image/jpeg")).toThrow("8000");
    const bigWebp = webp("VP8X"); bigWebp.writeUIntLE(8000, 27, 3);
    expect(() => validateImage(bigWebp, "image/webp")).toThrow("8000");
  });
  it("allows images-only messages, rejects empty, duplicate and too-many ids", () => {
    expect(CreateTaskRequest.parse({ prompt: "", attachmentIds: [attachmentId] }).attachmentIds).toEqual([attachmentId]);
    expect(ReplyRequest.parse({ text: "", attachmentIds: [attachmentId] }).text).toBe("");
    expect(() => CreateTaskRequest.parse({ prompt: " " })).toThrow();
    expect(() => ReplyRequest.parse({ text: "" })).toThrow();
    expect(() => AttachmentIds.parse(nineIds)).toThrow();
    expect(() => AttachmentIds.parse([attachmentId, attachmentId])).toThrow();
  });
  it.each([{ rows: [] }, { rows: [{ ...row(), agent_id: otherAgent }] }, { rows: [{ ...row(), task_id: taskId }] }])("refuses invalid bindings before a write", async ({ rows }) => {
    const query = vi.fn().mockResolvedValue({ rows });
    await expect(bindAttachments({ query } as unknown as Tx, agentId, taskId, [attachmentId])).rejects.toMatchObject({ status: 400 });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("serializes a single stdin line with image blocks before text for new and resumed runs", () => {
    for (const images of [[], [{ mediaType: "image/png" as const, data: png.toString("base64") }]]) {
      const line = claudeUserMessage("one\ntwo", images);
      expect(line.split("\n")).toHaveLength(2);
      expect(JSON.parse(line)).toEqual({ type: "user", message: { role: "user", content: [...images.map(image => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })), { type: "text", text: "one\ntwo" }] } });
      for (const resume of [false, true]) expect(claudeTaskArgv({ runId: taskId, sessionId: taskId, model: "claude-opus-4-6", effort: "high", resume })).toContain("--input-format");
    }
  });
});

function httpDeps(query: ReturnType<typeof vi.fn>): HttpDeps {
  return { config: { appOrigin: "https://quokkabot.test", appHost: "quokkabot.test", viewOrigin: "https://view.quokkabot.test", viewHost: "view.quokkabot.test", agents: [{ agentId }] },
    slots: { require: async () => ({}), acquire: async () => () => undefined },
    db: { query }, auth: { session: vi.fn().mockResolvedValue({ hash: "owner" }) }, audit: { append: vi.fn(), textDigest: (text: string) => ({ hmac: "digest", length: text.length }) },
    log: pino({ level: "silent" }), webRoot: "/missing" } as unknown as HttpDeps;
}
describe("owner image routes", () => {
  it("refuses image bytes when their agent slot is no longer added", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()] });
    const deps = httpDeps(query);
    const require = vi.spyOn(deps.slots, "require").mockRejectedValue(new HttpError(404, "unknown_agent", "No such agent."));
    const { app } = buildServer(deps);
    try {
      const result = await app.inject({ url: `/api/attachments/${attachmentId}/content`, headers: { host: "quokkabot.test" } });
      expect(result.statusCode).toBe(404);
      expect(result.json().error.code).toBe("unknown_agent");
      expect(require).toHaveBeenCalledWith(agentId);
      expect(result.rawPayload.equals(png)).toBe(false);
    } finally { await app.close(); }
  });
  it("uploads bytes with a digest-only audit entry and serves private inline content", async () => {
    const query = vi.fn().mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.startsWith("delete from attachments")) return { rows: [] };
      if (sql.startsWith("insert into attachments")) return { rows: [{ ...row(), name: values[2] }] };
      if (sql.startsWith("select * from attachments")) return { rows: [row()] };
      throw new Error(sql);
    });
    const deps = httpDeps(query); const { app } = buildServer(deps);
    try {
      const uploaded = await app.inject({ method: "POST", url: `/api/agents/${agentId}/attachments?name=photo.png`, headers: { host: "quokkabot.test", origin: "https://quokkabot.test", "content-type": "image/png" }, payload: png });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json()).toMatchObject({ id: attachmentId, bytes: png.length });
      expect(deps.audit.append).toHaveBeenCalledWith(agentId, "owner", "attachment.added", { name: { hmac: "digest", length: 9 }, type: "image/png", bytes: png.length, sha256: sha256Hex(png) });
      const content = await app.inject({ method: "GET", url: `/api/attachments/${attachmentId}/content`, headers: { host: "quokkabot.test" } });
      expect(content.statusCode).toBe(200); expect(content.rawPayload).toEqual(png);
      for (const [key, value] of Object.entries(attachmentHeaders(row()))) expect(content.headers[key]).toBe(value);
      expect(content.headers["content-disposition"]).toBe("inline; filename*=UTF-8''photo%20%27%C3%A9.png");
      const page = await app.inject({ method: "GET", url: "/api/missing", headers: { host: "quokkabot.test" } });
      expect(page.headers["content-security-policy"]).toContain("img-src 'self' data: blob:");
      vi.mocked(deps.auth.session).mockResolvedValue(null);
      expect((await app.inject({ method: "GET", url: `/api/attachments/${attachmentId}/content`, headers: { host: "quokkabot.test" } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it("rejects oversized uploads, mismatched types, wrong origin and too-many ids with 4xx", async () => {
    const deps = httpDeps(vi.fn()); const { app } = buildServer(deps);
    try {
      const headers = { host: "quokkabot.test", origin: "https://quokkabot.test", "content-type": "image/png" };
      expect((await app.inject({ method: "POST", url: `/api/agents/${agentId}/attachments?name=x.png`, headers, payload: Buffer.alloc(MAX_IMAGE_BYTES + 1) })).statusCode).toBe(413);
      expect((await app.inject({ method: "POST", url: `/api/agents/${agentId}/attachments?name=x.png`, headers, payload: gif() })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `/api/agents/${agentId}/attachments?name=x.png`, headers: { ...headers, origin: "https://evil.test" }, payload: png })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/api/agents/${agentId}/tasks`, headers: { ...headers, "content-type": "application/json" }, payload: { prompt: "", attachmentIds: nineIds } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});

// A transaction-aware store exercises the real message and dispatch methods without a PostgreSQL socket.
function workflow(attachmentRows: AttachmentRow[]) {
  let task = { id: taskId, agent_id: agentId, title: "Task", prompt: "Original", state: "running", pending_prompt: null, pending_attachment_ids: [], session_id: taskId, session_started: true, model: "claude-opus-4-6", effort: "high", created_at: new Date(), updated_at: new Date(), result_summary: null, error: null } as unknown as TaskRow;
  let request = { id: otherAgent, task_id: taskId, kind: "question", text: "Which screenshot?", answered_at: null, created_at: new Date() } as OwnerRequestRow;
  let attachments = attachmentRows;
  let events: unknown[] = [];
  const runRows: RunRow[] = [];
  let rollback: () => void;
  const query = vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (sql === "BEGIN") { const previous = { task, request, attachments, events: [...events] }; rollback = () => { task = previous.task; request = previous.request; attachments = previous.attachments; events = previous.events; }; return { rows: [] }; }
    if (sql === "ROLLBACK") { rollback(); return { rows: [] }; }
    if (sql === "COMMIT") return { rows: [] };
    if (sql.startsWith("select * from tasks where id")) return { rows: [task] };
    if (sql.startsWith("update domain_requests set decided_at = now(), decision = 'skip'")) return { rows: [] };
    if (sql.startsWith("update owner_requests")) { const old = request; request = { ...request, answered_at: new Date() }; return { rows: old.answered_at ? [] : [request] }; }
    if (sql.startsWith("update tasks set pending_prompt")) { task = { ...task, pending_prompt: String(values[1]), pending_attachment_ids: values[2] as string[] }; return { rows: [task] }; }
    if (sql.startsWith("select * from attachments where id")) return { rows: attachments.filter(row => (values[0] as string[]).includes(row.id)) };
    if (sql.startsWith("update attachments")) { attachments = attachments.map(row => ({ ...row, task_id: taskId })); return { rows: [] }; }
    if (sql.startsWith("select * from attachments where task_id")) return { rows: attachments.filter(row => row.task_id === taskId) };
    if (sql.startsWith("select count(*)")) return { rows: [{ n: 2 }] };
    if (sql.startsWith("insert into runs")) { const run = { id: values[0], task_id: taskId, agent_id: agentId, attempt: 2, state: "starting", prompt: values[4], resume: values[5], attachment_ids: values[7], started_at: new Date(), ended_at: null, last_event_at: null, exit_code: null } as RunRow; runRows.push(run); return { rows: [run] }; }
    if (sql.startsWith("update tasks set state = 'running'")) { task = { ...task, pending_prompt: null, pending_attachment_ids: [] }; return { rows: [] }; }
    if (sql.startsWith("update runs") || sql.startsWith("update tasks set session_started")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const db = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Db;
  const supervisor = { resetTools: vi.fn(), writeWorkspaceFile: vi.fn(), startRun: vi.fn() };
  const service = new TaskService(db, { append: async (_tx: unknown, _id: string, event: unknown) => { events.push(event); } } as never,
    { append: vi.fn(), textDigest: vi.fn() } as never, supervisor as never, { isRunning: async () => true, setLease: vi.fn() } as never,
    { push: vi.fn().mockResolvedValue(undefined) } as never, pino({ level: "silent" }), () => [agentId]);
  vi.spyOn(service, "kick").mockImplementation(() => undefined);
  Object.defineProperty(service, "watch", { value: vi.fn() });
  return { service, supervisor, runRows, query, task: () => task, request: () => request, events: () => events };
}
describe("message attachment transactions", () => {
  it.each([{ rows: [] }, { rows: [{ ...row(), agent_id: otherAgent }] }, { rows: [{ ...row(), task_id: taskId }] }])("rolls back invalid reply ids and appends no event", async ({ rows }) => {
    const test = workflow(rows);
    await expect(test.service.reply(taskId, "", [attachmentId])).rejects.toMatchObject({ status: 400 });
    expect(test.events()).toEqual([]); expect(test.task().pending_prompt).toBeNull(); expect(test.request().answered_at).toBeNull();
    expect(test.query).toHaveBeenCalledWith("ROLLBACK");
  });
  it("carries a reply's pending image onto its run and clears the pending list", async () => {
    const test = workflow([row()]);
    await test.service.reply(taskId, "", [attachmentId]);
    expect(test.task().pending_attachment_ids).toEqual([attachmentId]);
    expect(test.events()[0]).toMatchObject({ kind: "owner_message", text: "", attachments: [{ id: attachmentId, width: 1 }] });
    await (test.service as unknown as { startRun(task: TaskRow): Promise<void> }).startRun(test.task());
    expect(test.task().pending_attachment_ids).toEqual([]); expect(test.task().pending_prompt).toBeNull();
    expect(test.runRows[0]?.attachment_ids).toEqual([attachmentId]);
    expect(test.supervisor.writeWorkspaceFile).toHaveBeenCalledWith(agentId, "attachments/33333333-photo 'é.png", png);
    expect(test.supervisor.startRun).toHaveBeenCalledWith(agentId, expect.objectContaining({ resume: true, images: [{ mediaType: "image/png", data: png.toString("base64") }], prompt: expect.stringContaining("attachments/33333333-") }));
    expect(JSON.stringify(test.events())).not.toContain(png.toString("base64"));
  });
});
