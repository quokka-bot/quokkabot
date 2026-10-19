import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings, publicSettings, SettingsStore } from "../src/settings.js";
import { sanitizeDownloadName, uniqueDownloadName } from "../src/download-names.js";
import { reserveDownload } from "../src/download-storage.js";
import { contentFilename, downloadApiPath } from "../src/download-policy.js";
import { DownloadTarget } from "../src/schemas.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "quokkabot-settings-")); temporaryDirectories.push(path); return path; }

describe("settings", () => {
  it("creates and persists defaults when the file is missing", async () => {
    const filename = join(await temporary(), "nested/settings.json");
    const store = await SettingsStore.load(filename, "/tmp/Downloads/Quokka Bot");
    expect(store.get().version).toBe(1);
    expect(store.get().serverOrigin).toBeNull();
    expect(publicSettings(store.get())).toEqual({ launchAtLogin: false, notifications: true, notificationDetails: true });
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(store.get());
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
  });
  it("migrates older settings with missing default fields and serialises concurrent writes", async () => {
    const filename = join(await temporary(), "settings.json");
    await writeFile(filename, JSON.stringify({ notifications: false }));
    const store = await SettingsStore.load(filename, "/tmp/Downloads/Quokka Bot");
    await Promise.all([store.update({ notificationDetails: false }), store.update({ launchAtLogin: true })]);
    const reload = await SettingsStore.load(filename, "/tmp/Downloads/Quokka Bot");
    expect(publicSettings(reload.get())).toEqual({ notifications: false, notificationDetails: false, launchAtLogin: true });
    const copy = store.get(); copy.seenNotificationIds.push("mutated");
    expect(store.get().seenNotificationIds).toEqual([]);
    await expect(store.update({ downloadDir: "relative" })).rejects.toThrow();
    await expect(store.update({ notifications: true })).resolves.toMatchObject({ notifications: true });
  });
  it("fails on corrupted data and rejects invalid origins, paths and unbounded dedupe state", async () => {
    const filename = join(await temporary(), "settings.json");
    await writeFile(filename, "broken JSON");
    await expect(SettingsStore.load(filename, "/tmp/Downloads")).rejects.toThrow(/Cannot read/u);
    for (const patch of [{ version: 2 }, { notifications: "yes" }, { serverOrigin: "https://app.example.com" }, { downloadDir: "relative" }, { seenNotificationIds: Array.from({ length: 1001 }, (_, i) => String(i)) }, { serverOrigin: "https://app.example.com", viewOrigin: "https://evil.test" }]) {
      expect(() => parseSettings(patch, "/tmp/Downloads")).toThrow();
    }
  });
});

describe("download filenames", () => {
  it("removes path and control characters and preserves ordinary Unicode filenames", () => {
    expect(sanitizeDownloadName("../../report\u0000:final.pdf")).toBe("_.._report__final.pdf");
    expect(sanitizeDownloadName("... ")).toBe("download");
    expect(sanitizeDownloadName("CON.txt")).toBe("_CON.txt");
    expect(sanitizeDownloadName("Sąskaita 2026.pdf")).toBe("Sąskaita 2026.pdf");
    expect(sanitizeDownloadName("invoice\u202epdf.exe")).toBe("invoice_pdf.exe");
    const long = sanitizeDownloadName(`${"字".repeat(200)}.pdf`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });
  it("adds distinct suffixes before the extension, including extensionless names", () => {
    expect(uniqueDownloadName("report.pdf", 0)).toBe("report.pdf");
    expect(uniqueDownloadName("report.pdf", 1)).toBe("report (1).pdf");
    expect(uniqueDownloadName("report", 2)).toBe("report (2)");
    expect(() => uniqueDownloadName("report", -1)).toThrow();
  });
  it("reserves distinct files without overwriting existing data", async () => {
    const directory = await temporary();
    await writeFile(join(directory, "report.pdf"), "existing content");
    const one = reserveDownload(directory, "report.pdf");
    const two = reserveDownload(directory, "report.pdf");
    expect(one.name).toBe("report (1).pdf");
    expect(two.name).toBe("report (2).pdf");
    expect(await readFile(join(directory, "report.pdf"), "utf8")).toBe("existing content");
    expect((await stat(one.path)).mode & 0o777).toBe(0o600);
    expect((await stat(two.path)).size).toBe(0);
  });
  it("builds API paths only from validated IDs and workspace paths", () => {
    const id = "d1e742f7-406f-4e68-a596-a8e97801e24e";
    expect(downloadApiPath(DownloadTarget.parse({ fileId: id }))).toBe(`/api/files/${id}/content`);
    expect(downloadApiPath(DownloadTarget.parse({ agentId: id, path: "invoices/a & b.pdf" }))).toBe(`/api/agents/${id}/workspace-file?path=invoices%2Fa+%26+b.pdf`);
  });
  it("reads standard and UTF-8 attachment names and rejects invalid encoding", () => {
    expect(contentFilename('attachment; filename="report.pdf"', "download")).toBe("report.pdf");
    expect(contentFilename("attachment; filename*=UTF-8''S%C4%85skaita.pdf", "download")).toBe("Sąskaita.pdf");
    expect(contentFilename(null, "fallback.txt")).toBe("fallback.txt");
    expect(() => contentFilename("attachment; filename*=UTF-8''%ZZ", "download")).toThrow(/malformed/u);
  });
});
