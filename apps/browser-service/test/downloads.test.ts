import { createHash } from "node:crypto";
import { access, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadInfo, LIMITS } from "@quokkabot/shared";
import { Downloads } from "../src/downloads.js";
import { systemClock } from "../src/runtime.js";
import { GUID, harness, RUN_ID } from "./helpers.js";
import type { Harness } from "./helpers.js";
const instances: Harness[] = [];
async function setup() { const h = await harness(); instances.push(h); return h; }
afterEach(async () => { for (const h of instances.splice(0)) await h.cleanup(); });
const begin = { guid: GUID, url: "https://example.com/invoice.pdf", suggestedFilename: "invoice.pdf" };
async function listed(h: Harness) {
  const response = await h.request("GET", "/v1/downloads");
  expect(response.statusCode).toBe(200);
  return (response.body as { downloads: DownloadInfo[] }).downloads;
}
function complete(h: Harness, size: number) {
  h.cdp.event("Browser.downloadProgress", { guid: GUID, state: "completed", receivedBytes: size, totalBytes: size });
}

describe("download lifecycle", () => {
  it.each(["download", "click"])("registers before %s dispatch and associates CDP events with the running command", async (op) => {
    const h = await setup();
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    const run = h.runner.run;
    h.runner.run = async (path, argv, options) => {
      if (argv[7] === "click") h.cdp.event("Browser.downloadWillBegin", begin);
      return run(path, argv, options);
    };
    const result = await h.command({ op, tab: "t1", snapshot: snapshot.snapshot, ref: "e1" }, 2, "download_command");
    expect(result.status).toBe("ok"); expect(result.download?.suggestedFilename).toBe("invoice.pdf");
    const downloads = await listed(h);
    expect(downloads).toHaveLength(1);
    expect(DownloadInfo.parse(downloads[0])).toMatchObject({ state: "in_progress", commandId: "download_command", runId: RUN_ID, guid: GUID });
    expect(result.download?.downloadId).toBe(downloads[0]?.downloadId);
    h.cdp.event("Browser.downloadProgress", { guid: GUID, state: "inProgress", receivedBytes: 4, totalBytes: 10 });
    expect((await listed(h))[0]).toMatchObject({ receivedBytes: 4, totalBytes: 10, endedAt: null });
    complete(h, 10);
    expect((await listed(h))[0]).toMatchObject({ state: "completed", receivedBytes: 10, totalBytes: 10, endedAt: expect.any(String) });
    const argv = (await h.calls()).map((call) => call.slice(7));
    expect(argv.filter((call) => call[0] === "click")).toEqual([["click", "@e1"]]);
    expect(argv.some((call) => call[0] === "download")).toBe(false);
  });
  it("fails a download when no event begins within its wait, without repeating the click", async () => {
    const h = await setup();
    const snapshot = await h.command({ op: "snapshot", tab: "t1" });
    expect(await h.command({ op: "download", tab: "t1", snapshot: snapshot.snapshot, ref: "e1" }))
      .toMatchObject({ status: "failed", message: "no download started" });
    expect((await h.calls()).filter((call) => call[7] === "click")).toHaveLength(1);
    expect(await listed(h)).toEqual([]);
  });
  it("records owner-initiated downloads without a command or run", async () => {
    const h = await setup();
    await h.service.setControlLease({ holder: "owner", generation: 3, expiresAt: null });
    h.cdp.event("Browser.downloadWillBegin", begin);
    expect((await listed(h))[0]).toMatchObject({ commandId: null, runId: null });
    h.cdp.event("Browser.downloadProgress", { guid: GUID, state: "canceled", receivedBytes: 0, totalBytes: 0 });
    expect((await listed(h))[0]).toMatchObject({ state: "cancelled", endedAt: expect.any(String) });
  });
  it("cancels oversized downloads and keeps a failed durable record", async () => {
    const h = await setup();
    h.cdp.event("Browser.downloadWillBegin", begin);
    h.cdp.event("Browser.downloadProgress", { guid: GUID, state: "inProgress", receivedBytes: 4, totalBytes: LIMITS.downloadMaxBytes + 1 });
    expect((await listed(h))[0]?.state).toBe("failed");
    expect(h.cdp.calls).toContainEqual({ method: "Browser.cancelDownload", params: { guid: GUID } });
    complete(h, 4);
    expect((await listed(h))[0]?.state).toBe("failed");
  });
  it("persists in-progress and terminal state across a service restart", async () => {
    const h = await setup();
    h.cdp.event("Browser.downloadWillBegin", begin);
    h.cdp.event("Browser.downloadProgress", { guid: GUID, state: "inProgress", receivedBytes: 4, totalBytes: 12 });
    const inProgress = await listed(h);
    const restored = new Downloads(join(h.root, "staging"), systemClock, h.cdp);
    await restored.load();
    expect(restored.list()).toEqual(inProgress);
    await restored.event("Browser.downloadProgress", { guid: GUID, state: "completed", receivedBytes: 12, totalBytes: 12 }, undefined);
    const again = new Downloads(join(h.root, "staging"), systemClock, h.cdp);
    await again.load(); expect(again.list()[0]).toMatchObject({ state: "completed", receivedBytes: 12 });
    expect(JSON.parse(await readFile(join(h.root, "staging/.state.json"), "utf8"))).toEqual(again.list());
  });
  it("discovers a download that completes after an earlier since cursor", async () => {
    const h = await setup();
    const downloads = new Downloads(join(h.root, "staging"), { ...systemClock, now: () => new Date(time) }, h.cdp);
    let time = "2026-10-17T01:00:00.000Z";
    await downloads.load(); await downloads.event("Browser.downloadWillBegin", begin, undefined);
    time = "2026-10-17T01:05:00.000Z";
    await downloads.event("Browser.downloadProgress", { guid: GUID, state: "completed", receivedBytes: 10, totalBytes: 10 }, undefined);
    expect(downloads.list("2026-10-17T01:04:00Z")).toHaveLength(1);
    expect(downloads.list("2026-10-17T01:06:00Z")).toHaveLength(0);
    expect((await h.request("GET", "/v1/downloads?since=invalid")).statusCode).toBe(400);
  });
});

describe("download content boundary", () => {
  it("streams the verified staging descriptor with a precomputed SHA-256 and deletes it on ack", async () => {
    const h = await setup();
    const bytes = Buffer.from("invoice contents\n");
    await writeFile(join(h.root, "staging", GUID), bytes);
    h.cdp.event("Browser.downloadWillBegin", begin); complete(h, bytes.length);
    const item = (await listed(h))[0]!;
    const content = await h.request("GET", `/v1/downloads/${item.downloadId}/content`);
    expect(content.statusCode).toBe(200);
    expect(content.headers?.["x-quokkabot-sha256"]).toBe(createHash("sha256").update(bytes).digest("hex"));
    const chunks: Buffer[] = [];
    for await (const chunk of content.stream!) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect((await h.request("POST", `/v1/downloads/${item.downloadId}/ack`)).statusCode).toBe(200);
    await expect(access(join(h.root, "staging", GUID))).rejects.toThrow();
    expect(await listed(h)).toEqual([]);
    expect(JSON.parse(await readFile(join(h.root, "staging/.state.json"), "utf8"))).toEqual([]);
  });
  it("refuses in-progress files, symlinks and size mismatches", async () => {
    const h = await setup();
    h.cdp.event("Browser.downloadWillBegin", begin);
    const item = (await listed(h))[0]!;
    expect((await h.request("GET", `/v1/downloads/${item.downloadId}/content`)).statusCode).toBe(409);
    expect((await h.request("POST", `/v1/downloads/${item.downloadId}/ack`)).statusCode).toBe(409);
    const outside = join(h.root, "outside-secret");
    await writeFile(outside, "secret"); await symlink(outside, join(h.root, "staging", GUID));
    complete(h, 6); await listed(h);
    expect((await h.request("GET", `/v1/downloads/${item.downloadId}/content`)).statusCode).toBe(409);
    await unlink(join(h.root, "staging", GUID)); await writeFile(join(h.root, "staging", GUID), "too big");
    expect((await h.request("GET", `/v1/downloads/${item.downloadId}/content`)).statusCode).toBe(409);
  });
  it("fails startup on corrupt download state instead of discarding it", async () => {
    const h = await setup();
    await writeFile(join(h.root, "staging/.state.json"), "broken");
    const restored = new Downloads(join(h.root, "staging"), systemClock, h.cdp);
    await expect(restored.load()).rejects.toThrow();
  });
});
