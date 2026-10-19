import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FilesRequest, FilesResult, LIMITS } from "@quokkabot/shared";
import { exportFile, handle, type FilesEnvironment } from "../src/handle.js";
import { Writable } from "node:stream";
import { replaceText, textPage, utf8Text } from "../src/text.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const main = join(packageRoot, "dist/main.js");
const compiler = join(packageRoot, "../../node_modules/typescript/bin/tsc");
let temporary: string;
let workspace: string;
let downloads: string;
let env: FilesEnvironment;

beforeAll(async () => {
  execFileSync(process.execPath, [compiler, "-p", join(packageRoot, "tsconfig.build.json")], { encoding: "utf8" });
  // Compile the real, unchanged dependency into a slice-local runtime fixture. This keeps
  // subprocess tests independent of another slice's build without modifying packages/shared.
  const sharedRuntime = join(packageRoot, "dist/node_modules/@quokkabot/shared");
  execFileSync(process.execPath, [compiler, "-p", join(packageRoot, "../../packages/shared/tsconfig.build.json"), "--outDir", sharedRuntime], { encoding: "utf8" });
  await writeFile(join(sharedRuntime, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
});

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), "qb-files-test-")));
  workspace = join(temporary, "workspace");
  downloads = join(temporary, "downloads");
  await mkdir(workspace);
  await mkdir(downloads);
  env = { QB_WORKSPACE: workspace, QB_DOWNLOADS: downloads };
});

afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

async function call(request: unknown): Promise<FilesResult> {
  return FilesResult.parse(await handle(request, env));
}

function cli(input: string | unknown, args: string[] = []) {
  return spawnSync(process.execPath, [main, ...args], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, ...env },
    maxBuffer: 4 * 1024 * 1024,
  });
}

function digest(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

async function put(root: string, path: string, content: string | Buffer): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function* strings(...chunks: string[]) { yield* chunks; }

describe("list", () => {
  it("includes hidden entries, sorts directories first by name, and reports relative paths and metadata", async () => {
    await mkdir(join(workspace, "nested/z-dir"), { recursive: true });
    await mkdir(join(workspace, "nested/a-dir"));
    await put(workspace, "nested/z.txt", "abc");
    await put(workspace, "nested/.hidden", "x");
    const result = await call({ op: "list", scope: "workspace", dir: "nested" });
    expect(result.op).toBe("list");
    if (result.op !== "list") throw new Error(JSON.stringify(result));
    expect(result.entries.map((entry) => [entry.name, entry.path, entry.type])).toEqual([
      ["a-dir", "nested/a-dir", "dir"], ["z-dir", "nested/z-dir", "dir"],
      [".hidden", "nested/.hidden", "file"], ["z.txt", "nested/z.txt", "file"],
    ]);
    expect(result.entries.at(-1)?.bytes).toBe(3);
    expect(Number.isNaN(Date.parse(result.entries[0]?.modifiedAt ?? "invalid"))).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("paginates without duplicating entries and lists the downloads root", async () => {
    const names = Array.from({ length: LIMITS.filesListEntries + 3 }, (_, i) => `${String(i).padStart(3, "0")}.txt`);
    await Promise.all(names.map((name) => put(downloads, name, "")));
    const first = await call({ op: "list", scope: "downloads", dir: "." });
    if (first.op !== "list") throw new Error(JSON.stringify(first));
    expect(first.entries.length).toBeGreaterThan(0);
    expect(first.entries.length).toBeLessThanOrEqual(LIMITS.filesListEntries);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(LIMITS.toolResultChars);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await call({ op: "list", scope: "downloads", dir: "", cursor: first.nextCursor });
    if (second.op !== "list") throw new Error(JSON.stringify(second));
    expect([...first.entries, ...second.entries].map((entry) => entry.name)).toEqual(names);
    expect(second.nextCursor).toBeNull();
    expect(await call({ op: "list", scope: "workspace", dir: "" })).toEqual({ op: "list", entries: [], nextCursor: null });
  });

  it("hides the control plane's publishing area at the downloads root only", async () => {
    await mkdir(join(downloads, ".incoming"));
    await put(downloads, ".incoming/partial", "x");
    await put(downloads, "invoice.pdf", "%PDF-");
    await mkdir(join(workspace, ".incoming"));
    const listed = await call({ op: "list", scope: "downloads", dir: "" });
    if (listed.op !== "list") throw new Error(JSON.stringify(listed));
    expect(listed.entries.map((entry) => entry.name)).toEqual(["invoice.pdf"]);
    const workspaceListed = await call({ op: "list", scope: "workspace", dir: "" });
    if (workspaceListed.op !== "list") throw new Error(JSON.stringify(workspaceListed));
    expect(workspaceListed.entries.map((entry) => entry.name)).toEqual([".incoming"]);
  });

  it("paginates long paths below the serialized tool result character cap", async () => {
    const names = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(220)}`);
    await Promise.all(names.map((name) => put(workspace, `nested/${name}`, "")));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await call({ op: "list", scope: "workspace", dir: "nested", ...(cursor === undefined ? {} : { cursor }) });
      if (result.op !== "list") throw new Error(JSON.stringify(result));
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.entries.length).toBeLessThanOrEqual(LIMITS.filesListEntries);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(LIMITS.toolResultChars);
      seen.push(...result.entries.map((entry) => entry.name));
      cursor = result.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual(names);
  });

  it.each(["", "not-a-cursor", Buffer.from("list:-1").toString("base64url"), Buffer.from("list:9007199254740992").toString("base64url")])("rejects invalid cursor %s", async (cursor) => {
    expect(await call({ op: "list", scope: "workspace", dir: "", cursor })).toMatchObject({ op: "error", code: "invalid" });
  });
});

describe("text reads", () => {
  it("numbers lines like cat -n, preserves CRLF and the final unterminated line", async () => {
    await put(workspace, "text", "one\r\n\n三🙂");
    expect(await call({ op: "read", scope: "workspace", path: "text", limit: 2 })).toEqual({
      op: "read", kind: "text", mimeType: "text/plain", content: "     1\tone\r\n     2\t\n", totalLines: 3, nextOffset: 3,
    });
    expect(await call({ op: "read", scope: "workspace", path: "text", offset: 3 })).toMatchObject({ content: "     3\t三🙂", totalLines: 3, nextOffset: null });
    expect(await call({ op: "read", scope: "workspace", path: "text", offset: 4 })).toMatchObject({ content: "", totalLines: 3, nextOffset: null });
  });

  it.each([["", 0, ""], ["\n", 1, "     1\t\n"], ["a\n", 1, "     1\ta\n"], ["a\n\n", 2, "     1\ta\n     2\t\n"]])("counts lines in %j", async (text, totalLines, content) => {
    await put(downloads, "lines", text as string);
    expect(await call({ op: "read", scope: "downloads", path: "lines" })).toMatchObject({ totalLines, content, nextOffset: null });
  });

  it("uses the default line count and paginates the remainder", async () => {
    await put(workspace, "many", "a\n".repeat(LIMITS.fileReadDefaultLines + 1));
    const first = await call({ op: "read", scope: "workspace", path: "many" });
    expect(first).toMatchObject({ totalLines: LIMITS.fileReadDefaultLines + 1, nextOffset: LIMITS.fileReadDefaultLines + 1 });
    expect(await call({ op: "read", scope: "workspace", path: "many", offset: LIMITS.fileReadDefaultLines + 1 })).toMatchObject({ content: "   401\ta\n", nextOffset: null });
  });

  it("caps characters including line numbers, stops at a line boundary, and resumes", async () => {
    const line = "x".repeat(LIMITS.fileReadChars / 2 - 8);
    await put(workspace, "cap", `${line}\n${line}\nz\n`);
    const first = await call({ op: "read", scope: "workspace", path: "cap" });
    expect(first).toMatchObject({ content: `     1\t${line}\n     2\t${line}\n`, totalLines: 3, nextOffset: 3 });
    if (first.op !== "read") throw new Error(JSON.stringify(first));
    expect(first.content.length).toBe(LIMITS.fileReadChars);
    expect(await call({ op: "read", scope: "workspace", path: "cap", offset: 3 })).toMatchObject({ content: "     3\tz\n", nextOffset: null });
  });

  it("refuses an oversized single line without a nonadvancing cursor", async () => {
    await put(workspace, "long", `ok\n${"x".repeat(LIMITS.fileReadChars)}\nend`);
    expect(await call({ op: "read", scope: "workspace", path: "long" })).toMatchObject({ content: "     1\tok\n", totalLines: 3, nextOffset: 2 });
    expect(await call({ op: "read", scope: "workspace", path: "long", offset: 2 })).toMatchObject({ op: "error", code: "too_large" });
    expect(await call({ op: "read", scope: "workspace", path: "long", offset: 3 })).toMatchObject({ content: "     3\tend" });
  });

  it("handles UTF-8 and newline boundaries split across byte chunks", async () => {
    const bytes = Buffer.from("🙂\nlast");
    async function* chunks() { for (const byte of bytes) yield Buffer.from([byte]); }
    expect(await textPage(utf8Text(chunks()), 1, 10)).toEqual({ content: "     1\t🙂\n     2\tlast", totalLines: 2, nextOffset: null });
  });

  it.each([Buffer.from([0, 65]), Buffer.from([0xff, 0xfe]), Buffer.from([0xe2, 0x82])])("rejects binary and malformed UTF-8 %#", async (bytes) => {
    await put(workspace, "binary", bytes);
    expect(await call({ op: "read", scope: "workspace", path: "binary" })).toEqual({ op: "error", code: "not_a_file", message: "binary file; use workspace_exec to convert it" });
  });

  it("validates UTF-8 after a full page and checks NUL only in the first 8 KB", async () => {
    await put(workspace, "late-invalid", Buffer.concat([Buffer.from("ok\n".repeat(30_000)), Buffer.from([0xff])]));
    expect(await call({ op: "read", scope: "workspace", path: "late-invalid", limit: 1 })).toMatchObject({ op: "error", code: "not_a_file" });
    await put(workspace, "nul-boundary", `${"a".repeat(8191)}\0`);
    expect(await call({ op: "read", scope: "workspace", path: "nul-boundary" })).toMatchObject({ op: "error", code: "not_a_file" });
    await put(workspace, "later-nul", `${"a".repeat(8192)}\0`);
    expect(await call({ op: "read", scope: "workspace", path: "later-nul" })).toMatchObject({ op: "read", kind: "text" });
  });
});

describe("images and PDFs", () => {
  const images = [
    ["image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0])],
    ["image/gif", Buffer.from("GIF87a\0")],
    ["image/gif", Buffer.from("GIF89a\0")],
    ["image/webp", Buffer.from("RIFF\0\0\0\0WEBP\0")],
  ] as const;
  it.each(images)("detects %s by magic bytes regardless of filename", async (mimeType, bytes) => {
    await put(downloads, "image.txt", bytes);
    expect(await call({ op: "read", scope: "downloads", path: "image.txt" })).toEqual({ op: "read", kind: "image", mimeType, content: bytes.toString("base64"), totalLines: null, nextOffset: null });
  });

  it("accepts the image byte cap and rejects one byte above it", async () => {
    const bytes = Buffer.alloc(LIMITS.screenshotMaxBytes);
    Buffer.from("GIF89a").copy(bytes);
    await put(workspace, "cap", bytes);
    expect(await call({ op: "read", scope: "workspace", path: "cap" })).toMatchObject({ op: "read", kind: "image", content: bytes.toString("base64") });
    await put(workspace, "over", Buffer.concat([bytes, Buffer.from([0])]));
    expect(await call({ op: "read", scope: "workspace", path: "over" })).toMatchObject({ op: "error", code: "too_large" });
  });

  async function fakePdf(body: string): Promise<void> {
    const executable = join(temporary, "fake pdftotext.cjs");
    await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
    env.QB_PDFTOTEXT = executable;
  }

  it("runs pdftotext with fixed arguments and paginates its UTF-8 output", async () => {
    const path = "invoice $(touch nope);.bin";
    await put(workspace, path, "%PDF-1.7\n\0");
    await fakePdf(`const expected = ${JSON.stringify(["-layout", "-enc", "UTF-8", join(workspace, path), "-"])};\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(9);\nprocess.stdout.write('Invoice\\n€10\\nEnd');`);
    expect(await call({ op: "read", scope: "workspace", path, offset: 2, limit: 1 })).toEqual({ op: "read", kind: "pdf_text", mimeType: "text/plain", content: "     2\t€10\n", totalLines: 3, nextOffset: 3 });
    expect(await call({ op: "read", scope: "workspace", path, offset: 3 })).toMatchObject({ content: "     3\tEnd", nextOffset: null });
    expect(await readdir(workspace)).toEqual([path]);
  });

  it("returns converter failures, never partial PDF text or a text fallback", async () => {
    await put(workspace, "broken", "%PDF-1.7\n");
    await fakePdf("process.stdout.write('partial'); process.stderr.write('bad PDF'); process.exitCode = 7;");
    expect(await call({ op: "read", scope: "workspace", path: "broken" })).toMatchObject({ op: "error", code: "not_a_file", message: expect.stringContaining("bad PDF") });
    env.QB_PDFTOTEXT = join(temporary, "missing");
    expect(await call({ op: "read", scope: "workspace", path: "broken" })).toMatchObject({ op: "error", code: "refused", message: expect.stringContaining("Unable to run pdftotext") });
  });
});

describe("writes, edits, copies and stat", () => {
  it("creates parents, atomically replaces files, reports UTF-8 bytes, and leaves no temporary files", async () => {
    expect(await call({ op: "write", path: "a/b/file", content: "€🙂" })).toEqual({ op: "write", bytes: 7 });
    expect(await readFile(join(workspace, "a/b/file"), "utf8")).toBe("€🙂");
    expect(await call({ op: "write", path: "a/b/file", content: "new" })).toEqual({ op: "write", bytes: 3 });
    expect(await readdir(join(workspace, "a/b"))).toEqual(["file"]);
    expect((await lstat(join(workspace, "a/b/file"))).mode & 0o777).toBe(0o600);
  });

  it("edits exactly one match", async () => {
    await put(workspace, "edit", "before OLD after");
    expect(await call({ op: "edit", path: "edit", oldString: "OLD", newString: "new €", replaceAll: false })).toEqual({ op: "edit", replacements: 1 });
    expect(await readFile(join(workspace, "edit"), "utf8")).toBe("before new € after");
  });

  it("does not change the file for no match or multiple matches and cleans the temporary file", async () => {
    await put(workspace, "edit", "one one one");
    expect(await call({ op: "edit", path: "edit", oldString: "absent", newString: "new", replaceAll: false })).toMatchObject({ op: "error", code: "no_match" });
    expect(await call({ op: "edit", path: "edit", oldString: "one", newString: "new", replaceAll: false })).toMatchObject({ op: "error", code: "multiple_matches", message: expect.stringContaining("3 matches") });
    expect(await readFile(join(workspace, "edit"), "utf8")).toBe("one one one");
    expect(await readdir(workspace)).toEqual(["edit"]);
    expect(await call({ op: "edit", path: "edit", oldString: "one", newString: "", replaceAll: true })).toEqual({ op: "edit", replacements: 3 });
    expect(await readFile(join(workspace, "edit"), "utf8")).toBe("  ");
  });

  it("replaces matches spanning stream chunks and preserves Unicode", async () => {
    const content = `${"a".repeat(65_534)}🙂OLD🙂OLD`;
    await put(workspace, "edit", content);
    expect(await call({ op: "edit", path: "edit", oldString: "🙂OLD", newString: "€", replaceAll: true })).toEqual({ op: "edit", replacements: 2 });
    expect(await readFile(join(workspace, "edit"), "utf8")).toBe(`${"a".repeat(65_534)}€€`);
    let matches = 0;
    const output: string[] = [];
    for await (const text of replaceText(strings("a🙂OL", "D🙂O", "LDz"), "🙂OLD", "$&", () => { matches += 1; })) output.push(text);
    expect(output.join("")).toBe("a$&$&z");
    expect(matches).toBe(2);
  });

  it("uses nonoverlapping matches and rejects a binary edit without changing the original", async () => {
    await put(workspace, "edit", "aaaaa");
    expect(await call({ op: "edit", path: "edit", oldString: "aa", newString: "b", replaceAll: true })).toEqual({ op: "edit", replacements: 2 });
    expect(await readFile(join(workspace, "edit"), "utf8")).toBe("bba");
    const bytes = Buffer.from([65, 0, 66]);
    await put(workspace, "binary", bytes);
    expect(await call({ op: "edit", path: "binary", oldString: "A", newString: "X", replaceAll: true })).toMatchObject({ op: "error", code: "not_a_file" });
    expect(await readFile(join(workspace, "binary"))).toEqual(bytes);
  });

  it("copies raw downloads atomically and returns the hash of exactly those bytes", async () => {
    const bytes = Buffer.from([0, 255, 1, 2, 3]);
    await put(downloads, "file", bytes);
    expect(await call({ op: "copy_from_downloads", source: "file", dest: "copied/file" })).toEqual({ op: "copy_from_downloads", bytes: bytes.length, sha256: digest(bytes) });
    expect(await readFile(join(workspace, "copied/file"))).toEqual(bytes);
    expect(await readFile(join(downloads, "file"))).toEqual(bytes);
    expect(await call({ op: "copy_from_downloads", source: "file", dest: "copied/file" })).toMatchObject({ bytes: bytes.length, sha256: digest(bytes) });
    expect(await readdir(join(workspace, "copied"))).toEqual(["file"]);
  });

  it("rolls back an edit if invalid UTF-8 is discovered after writing temporary output", async () => {
    const bytes = Buffer.concat([Buffer.from(`OLD\n${"x".repeat(70_000)}`), Buffer.from([0xff])]);
    await put(workspace, "edit", bytes);
    expect(await call({ op: "edit", path: "edit", oldString: "OLD", newString: "new", replaceAll: true })).toMatchObject({ op: "error", code: "not_a_file" });
    expect(await readFile(join(workspace, "edit"))).toEqual(bytes);
    expect(await readdir(workspace)).toEqual(["edit"]);
  });

  it("stats a file, directory and file larger than the hashing cap", async () => {
    await put(workspace, "dir/file", "hash me");
    const result = await call({ op: "stat", scope: "workspace", path: "dir/file" });
    expect(result).toMatchObject({ op: "stat", entry: { name: "file", path: "dir/file", type: "file", bytes: 7 }, sha256: digest("hash me") });
    expect(await call({ op: "stat", scope: "workspace", path: "dir" })).toMatchObject({ op: "stat", entry: { type: "dir", path: "dir" }, sha256: null });
    const large = await open(join(downloads, "large"), "w");
    await large.truncate(LIMITS.downloadMaxBytes + 1);
    await large.close();
    expect(await call({ op: "stat", scope: "downloads", path: "large" })).toMatchObject({ op: "stat", entry: { bytes: LIMITS.downloadMaxBytes + 1 }, sha256: null });
  });
});

describe("path and file refusals", () => {
  it.each(["target", "intermediate"])("refuses a symlink as %s for reads, stat, writes, edits, copies, list and export", async (kind) => {
    await put(temporary, "outside/file", "private");
    const path = kind === "target" ? "link" : "link/file";
    await symlink(kind === "target" ? join(temporary, "outside/file") : join(temporary, "outside"), join(workspace, "link"));
    await symlink(kind === "target" ? join(temporary, "outside/file") : join(temporary, "outside"), join(downloads, "link"));
    const requests = [
      { op: "read", scope: "workspace", path }, { op: "stat", scope: "workspace", path },
      { op: "write", path, content: "overwritten" }, { op: "edit", path, oldString: "private", newString: "X", replaceAll: true },
      { op: "copy_from_downloads", source: path, dest: "copy" },
      { op: "list", scope: "workspace", dir: kind === "target" ? "" : "link" },
    ];
    for (const request of requests) expect(await call(request)).toMatchObject({ op: "error", code: "refused", message: expect.stringContaining("Symlinks") });
    expect(await readFile(join(temporary, "outside/file"), "utf8")).toBe("private");
    const exported = cli({ scope: "workspace", path }, ["export"]);
    expect(exported.status).toBe(1);
    expect(exported.stdout.length).toBe(0);
  });

  it("refuses symlinks into the same root, symlink roots, dangling symlinks and hard links", async () => {
    await put(workspace, "file", "hello");
    await symlink(join(workspace, "file"), join(workspace, "internal"));
    await symlink(join(workspace, "missing"), join(workspace, "dangling"));
    for (const path of ["internal", "dangling"]) {
      expect(await call({ op: "write", path, content: "X" })).toMatchObject({ op: "error", code: "refused" });
    }
    await symlink(workspace, join(temporary, "root-link"));
    expect(await handle({ op: "list", scope: "workspace", dir: "" }, { QB_WORKSPACE: join(temporary, "root-link") })).toMatchObject({ op: "error", code: "refused" });
    await link(join(workspace, "file"), join(downloads, "hard-link"));
    expect(await call({ op: "read", scope: "workspace", path: "file" })).toMatchObject({ op: "error", code: "refused", message: expect.stringContaining("Hard-linked") });
  });

  it("refuses FIFOs without blocking", async () => {
    execFileSync("mkfifo", [join(workspace, "fifo")]);
    for (const request of [
      { op: "read", scope: "workspace", path: "fifo" }, { op: "write", path: "fifo", content: "x" },
      { op: "stat", scope: "workspace", path: "fifo" }, { op: "list", scope: "workspace", dir: "" },
    ]) expect(await call(request)).toMatchObject({ op: "error", code: "refused", message: expect.stringContaining("Special files") });
    expect(cli({ scope: "workspace", path: "fifo" }, ["export"]).status).toBe(1);
  });

  it("reports missing files, directories used as files, and files used as directories", async () => {
    expect(await call({ op: "read", scope: "workspace", path: "missing" })).toMatchObject({ op: "error", code: "not_found" });
    expect(await call({ op: "read", scope: "workspace", path: "." })).toMatchObject({ op: "error", code: "not_a_file" });
    expect(await call({ op: "write", path: "", content: "x" })).toMatchObject({ op: "error", code: "not_a_file" });
    await put(workspace, "file", "x");
    expect(await call({ op: "write", path: "file/child", content: "x" })).toMatchObject({ op: "error", code: "not_a_file" });
    expect(await call({ op: "list", scope: "workspace", dir: "file" })).toMatchObject({ op: "error", code: "not_a_file" });
  });

  it("validates direct callers and never offers a downloads write", async () => {
    expect(FilesRequest.safeParse({ op: "write", scope: "downloads", path: "x", content: "x" }).success).toBe(false);
    await expect(handle({ op: "read", scope: "workspace", path: "../outside" }, env)).rejects.toThrow();
    expect(await handle({ op: "list", scope: "workspace", dir: "" }, { QB_WORKSPACE: "" })).toMatchObject({ op: "error", code: "invalid" });
  });
});

describe("CLI and export", () => {
  it("writes exactly one JSON result and exits zero for success and operation errors", () => {
    const success = cli({ op: "write", path: "written", content: "€" });
    expect(success.status).toBe(0);
    expect(success.stderr.toString()).toBe("");
    expect(success.stdout.toString()).toBe('{"op":"write","bytes":3}\n');
    const error = cli({ op: "read", scope: "workspace", path: "missing" });
    expect(error.status).toBe(0);
    expect(FilesResult.parse(JSON.parse(error.stdout.toString()))).toMatchObject({ op: "error", code: "not_found" });
  });

  it.each(["{", {}, { op: "read", scope: "workspace", path: "../secret" }, { op: "write", scope: "downloads", path: "x", content: "x" }, { op: "read", scope: "workspace", path: "/etc/passwd" }])("exits nonzero for invalid JSON or schema input %#", (input) => {
    const result = cli(input);
    expect(result.status).toBe(1);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.toString()).toContain("qb-files:");
  });

  it("exports exact bytes from either scope, including more than one stream chunk", async () => {
    const bytes = Buffer.alloc(200_003);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    for (const [scope, root] of [["workspace", workspace], ["downloads", downloads]] as const) {
      await put(root, "raw", bytes);
      const result = cli({ scope, path: "raw" }, ["export"]);
      expect(result.status).toBe(0);
      expect(result.stderr.length).toBe(0);
      expect(result.stdout).toEqual(bytes);
    }
  });

  it("fails export of a directory and invalid export input with no stdout", () => {
    for (const input of [{ scope: "workspace", path: "." }, { scope: "workspace", path: "../no" }, { op: "stat", scope: "workspace", path: "." }]) {
      const result = cli(input, ["export"]);
      expect(result.status).toBe(1);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    expect(cli({}, ["unknown"]).stderr.toString()).toContain("Usage: qb-files [export]");
  });

  it("propagates export destination errors", async () => {
    await put(workspace, "file", "bytes");
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("destination unavailable")); } });
    await expect(exportFile({ scope: "workspace", path: "file" }, output, env)).rejects.toThrow("destination unavailable");
  });
});
