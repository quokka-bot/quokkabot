import pino from "pino";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@quokkabot/shared";
import { UpstreamError } from "../src/clients.js";
import { HttpError } from "../src/errors.js";
import { buildServer, type HttpDeps } from "../src/http.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const fileId = "00000000-0000-4000-8000-0000000000f1";
const taskId = "00000000-0000-4000-8000-0000000000a1";
const sha256 = "b".repeat(64);
const generic = { error: { code: "internal", message: "The server hit an error. It is in the log." } };
const supervisorRefusal = (status: number, error: string, message: string) => new UpstreamError(`POST /v1/agents/${agentId}/files -> ${status}`, status, JSON.stringify({ error, message }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qb-library-"));
  const downloadsDir = join(root, "downloads");
  // Stands in for a sandbox-writable directory the control plane must never open.
  const workspaceDir = join(root, "workspace");
  await mkdir(downloadsDir);
  await mkdir(workspaceDir);
  const output: string[] = [];
  const log = pino({}, { write: (text) => { output.push(text); } });
  const published: { id: string; name: string; rel_path: string; bytes: number; sha256: string; mime_type: string; source_url: string | null; task_id: string | null; created_at: Date }[] = [];
  const workspaceRow = { agent_id: agentId, scope: "workspace", name: "notes.txt", rel_path: "notes.txt", mime_type: "text/plain", bytes: 5, evidence: false };
  const db = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("select agent_id from files")) return { rows: [{ agent_id: agentId }] };
      if (sql.startsWith("select agent_id, scope, name, rel_path")) return { rows: [workspaceRow] };
      if (sql.startsWith("select * from files where agent_id = $1 and scope = 'downloads'")) return { rows: published };
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
  const slots = { require: vi.fn(async (id: string) => { if (id !== agentId) throw new HttpError(404, "unknown_agent", "No such agent."); return { id }; }) };
  const supervisor = { files: vi.fn(), exportFile: vi.fn() };
  const { app } = await buildServer({
    config: {
      agents: [{ agentId, index: 1, downloadsDir }], appOrigin: "https://quokkabot.test", appHost: "quokkabot.test",
      viewHost: "view.quokkabot.test", viewOrigin: "https://view.quokkabot.test",
    },
    slots, db, supervisor, log, webRoot: "/missing",
    auth: { session: async () => ({ hash: "owner", freshUntil: new Date(Date.now() + 10_000) }) },
  } as unknown as HttpDeps);
  cleanups.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const get = (url: string) => app.inject({ url, headers: { host: "quokkabot.test", origin: "https://quokkabot.test" } });
  const failures = () => output.map((line) => JSON.parse(line) as { msg: string; err?: { message: string } }).filter((entry) => entry.msg === "request failed");
  return { downloadsDir, workspaceDir, published, supervisor, get, failures };
}

describe("Library Downloads", () => {
  it("lists the control plane's own published downloads with the computer stopped, without asking the supervisor", async () => {
    const { downloadsDir, published, supervisor, get } = await fixture();
    supervisor.files.mockRejectedValue(supervisorRefusal(409, "computer_stopped", "The computer is stopped"));
    await writeFile(join(downloadsDir, "invoice.pdf"), "%PDF-1.7 invoice");
    await writeFile(join(downloadsDir, "a-receipt.png"), "png");
    await mkdir(join(downloadsDir, ".incoming"));
    await writeFile(join(downloadsDir, ".incoming", "partial"), "half");
    await mkdir(join(downloadsDir, ".evidence"));
    await writeFile(join(downloadsDir, ".evidence", fileId), "copy");
    published.push({ id: fileId, name: "invoice.pdf", rel_path: "invoice.pdf", bytes: 16, sha256, mime_type: "application/pdf", source_url: "https://billing.example.com/invoice", task_id: taskId, created_at: new Date("2026-10-20T08:00:00.000Z") });
    const response = await get(`/api/agents/${agentId}/files?scope=downloads&dir=`);
    expect(response.statusCode).toBe(200);
    const listing = response.json();
    expect(listing).toMatchObject({ scope: "downloads", dir: "", nextCursor: null });
    expect(listing.entries).toEqual([
      { name: "a-receipt.png", path: "a-receipt.png", type: "file", bytes: 3, modifiedAt: expect.any(String), file: null },
      { name: "invoice.pdf", path: "invoice.pdf", type: "file", bytes: 16, modifiedAt: expect.any(String), file: {
        fileId, name: "invoice.pdf", bytes: 16, sha256, mimeType: "application/pdf", sourceUrl: "https://billing.example.com/invoice", taskId, createdAt: "2026-10-20T08:00:00.000Z",
      } },
    ]);
    expect(supervisor.files).not.toHaveBeenCalled();
  });

  it("says when Downloads is empty by listing nothing only after reading the folder", async () => {
    const { get } = await fixture();
    const response = await get(`/api/agents/${agentId}/files?scope=downloads`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ scope: "downloads", dir: "", entries: [], nextCursor: null });
  });

  it("pages Downloads and refuses a forged cursor", async () => {
    const { downloadsDir, get } = await fixture();
    const names = Array.from({ length: LIMITS.filesListEntries + 1 }, (_, index) => `invoice-${String(index).padStart(4, "0")}.pdf`);
    for (const name of names) await writeFile(join(downloadsDir, name), "x");
    const first = (await get(`/api/agents/${agentId}/files?scope=downloads`)).json();
    expect(first.entries).toHaveLength(LIMITS.filesListEntries);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await get(`/api/agents/${agentId}/files?scope=downloads&cursor=${first.nextCursor}`)).json();
    expect(second.entries.map((entry: { name: string }) => entry.name)).toEqual([names.at(-1)]);
    expect(second.nextCursor).toBeNull();
    const forged = await get(`/api/agents/${agentId}/files?scope=downloads&cursor=${Buffer.from("list:-1").toString("base64url")}`);
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.code).toBe("invalid_cursor");
  });

  it.each(["symlink", "hard link", "folder"] as const)("refuses a %s planted in Downloads and never follows it", async (kind) => {
    const { downloadsDir, workspaceDir, get, failures } = await fixture();
    await writeFile(join(workspaceDir, "private.txt"), "workspace secret");
    if (kind === "symlink") await symlink(join(workspaceDir, "private.txt"), join(downloadsDir, "leak.txt"));
    else if (kind === "hard link") await link(join(workspaceDir, "private.txt"), join(downloadsDir, "leak.txt"));
    else await mkdir(join(downloadsDir, "leak.txt"));
    const response = await get(`/api/agents/${agentId}/files?scope=downloads`);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(generic);
    expect(response.body).not.toContain("workspace secret");
    expect(failures()[0]?.err?.message).toBe('Downloads holds an entry that is not a published file: "leak.txt"');
  });

  it("keeps Downloads to its own folder", async () => {
    const { get, supervisor } = await fixture();
    expect((await get(`/api/agents/${agentId}/files?scope=downloads&dir=../workspace`)).statusCode).toBe(400);
    const nested = await get(`/api/agents/${agentId}/files?scope=downloads&dir=.evidence`);
    expect(nested.statusCode).toBe(404);
    expect(nested.json()).toEqual({ error: { code: "not_found", message: "Downloads has no folders." } });
    expect(supervisor.files).not.toHaveBeenCalled();
  });
});

describe("Library Workspace", () => {
  it("lists the workspace only through the supervisor's files helper", async () => {
    const { supervisor, get } = await fixture();
    const entry = { name: "report.csv", path: "out/report.csv", type: "file", bytes: 12, modifiedAt: "2026-10-20T08:00:00.000Z" };
    supervisor.files.mockResolvedValue({ op: "list", entries: [entry], nextCursor: "bGlzdDoy" });
    const response = await get(`/api/agents/${agentId}/files?scope=workspace&dir=out&cursor=bGlzdDox`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ scope: "workspace", dir: "out", entries: [{ ...entry, file: null }], nextCursor: "bGlzdDoy" });
    expect(supervisor.files).toHaveBeenCalledWith(agentId, { op: "list", scope: "workspace", dir: "out", cursor: "bGlzdDox" });
  });

  it.each([
    ["computer_stopped", "computer_stopped", "The computer is stopped. Start it to see the workspace files."],
    ["killed", "killed", "The kill switch is on. Release it and start the computer to see the workspace files."],
  ])("answers the supervisor's %s with a 409 that says what to do", async (supervisorCode, code, message) => {
    const { supervisor, get, failures } = await fixture();
    supervisor.files.mockRejectedValue(supervisorRefusal(409, supervisorCode, "refused"));
    const response = await get(`/api/agents/${agentId}/files?scope=workspace&dir=`);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code, message } });
    expect(failures()).toEqual([]);
  });

  it.each([
    ["a Docker failure", supervisorRefusal(502, "docker_failure", "Docker POST /containers/qb-tools-1/exec failed with HTTP 404: No such container: qb-tools-1")],
    ["a tools sandbox in another state", supervisorRefusal(502, "tools_unavailable", "The tools sandbox is paused")],
    ["another 409", supervisorRefusal(409, "busy", "An agent run is already active")],
    ["a 409 without the supervisor's error body", new UpstreamError("POST files -> 409", 409, "computer_stopped")],
    ["a stopped computer reported with another status", supervisorRefusal(502, "computer_stopped", "The computer is stopped")],
    ["an unreachable supervisor", new Error("connect ENOENT /supervisor.sock")],
  ])("keeps %s a logged error", async (_name, error) => {
    const { supervisor, get, failures } = await fixture();
    supervisor.files.mockRejectedValue(error);
    const response = await get(`/api/agents/${agentId}/files?scope=workspace`);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(generic);
    expect(failures()).toHaveLength(1);
  });

  it.each([
    ["the workspace file route", `/api/agents/${agentId}/workspace-file?path=notes.txt`],
    ["a workspace file record", `/api/files/${fileId}/content`],
  ])("says the computer is stopped when downloading through %s", async (_name, url) => {
    const { supervisor, get } = await fixture();
    supervisor.exportFile.mockRejectedValue(new UpstreamError("export 409", 409, JSON.stringify({ error: "computer_stopped", message: "The computer is stopped" })));
    const response = await get(url);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: "computer_stopped", message: "The computer is stopped. Start it to download this file." } });
    expect(supervisor.exportFile).toHaveBeenCalledWith(agentId, { scope: "workspace", path: "notes.txt" });
  });
});
