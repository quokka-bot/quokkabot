import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeWorkspaceBinary } from "../src/workspace.js";
import { DEFAULT_BODY_LIMIT, START_RUN_BODY_LIMIT, jsonBodyLimit, readBodyBytes } from "../src/server.js";
import { MAX_IMAGE_BASE64, MAX_MESSAGE_IMAGES } from "@quokkabot/shared";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "qb-image-workspace-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("workspace binary writes", () => {
  it("writes exact bytes and replaces an earlier copy", async () => {
    const data = Buffer.from([0, 255, 1, 128, 0, 10]);
    const own = vi.fn(async () => undefined);
    await writeWorkspaceBinary(root, "attachments/photo.png", data, own);
    expect(await readFile(join(root, "attachments/photo.png"))).toEqual(data);
    await writeWorkspaceBinary(root, "attachments/photo.png", Buffer.from("new"), own);
    expect(await readFile(join(root, "attachments/photo.png"), "utf8")).toBe("new");
    expect(own).toHaveBeenCalled();
  });
  it.each(["../escape.png", "attachments/../../escape.png", "/tmp/escape.png", "attachments/../escape.png", "attachments//photo.png", "attachments/./photo.png", "", ".", "attachments\\photo.png"])("refuses %j", async path => {
    await expect(writeWorkspaceBinary(root, path, Buffer.from("x"), async () => undefined)).rejects.toThrow();
  });
  it("refuses symlinked roots, parents and destination files without changing their target", async () => {
    const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "photo.png"), "untouched");
    const workspace = join(root, "workspace"); await mkdir(workspace);
    await symlink(outside, join(workspace, "attachments"));
    await expect(writeWorkspaceBinary(workspace, "attachments/photo.png", Buffer.from("bad"), async () => undefined)).rejects.toThrow();
    await symlink(outside, join(root, "linked-root"));
    await expect(writeWorkspaceBinary(join(root, "linked-root"), "photo.png", Buffer.from("bad"), async () => undefined)).rejects.toThrow();
    await symlink(join(outside, "photo.png"), join(workspace, "photo.png"));
    await expect(writeWorkspaceBinary(workspace, "photo.png", Buffer.from("bad"), async () => undefined)).rejects.toThrow();
    expect(await readFile(join(outside, "photo.png"), "utf8")).toBe("untouched");
  });
});
describe("supervisor body limits", () => {
  it("reserves the larger JSON budget for the start-run operation", async () => {
    expect(jsonBodyLimit("runs")).toBe(START_RUN_BODY_LIMIT);
    expect(START_RUN_BODY_LIMIT).toBeGreaterThan(MAX_IMAGE_BASE64 * MAX_MESSAGE_IMAGES + 100_000);
    for (const operation of ["exec", "files", "files/export", "computer/start", "runs/cleanup", "workspace-file", "runs/other", "unknown"]) expect(jsonBodyLimit(operation)).toBe(DEFAULT_BODY_LIMIT);
    const bytes = Buffer.alloc(DEFAULT_BODY_LIMIT + 1);
    await expect(readBodyBytes(Readable.from([bytes]) as IncomingMessage, jsonBodyLimit("files"))).rejects.toMatchObject({ status: 413 });
    expect((await readBodyBytes(Readable.from([bytes]) as IncomingMessage, jsonBodyLimit("runs"))).equals(bytes)).toBe(true);
  });
});
