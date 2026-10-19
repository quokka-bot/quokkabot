import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mimeFor, safeFileName, uniqueName } from "../src/files.js";

describe("safeFileName", () => {
  it.each([
    ["invoice-2026-10.pdf", "invoice-2026-10.pdf"],
    ["../../etc/passwd", "passwd"],
    ["a\\b\\c.pdf", "c.pdf"],
    [".hidden.pdf", "hidden.pdf"],
    ["-rf.pdf", "rf.pdf"],
    ["bad\u0000name\u0007.pdf", "bad_name_.pdf"],
    ["", "download"],
    ["...", "download"],
  ])("%j -> %j", (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });
  it("keeps the extension when cutting long names", () => {
    const name = safeFileName(`${"x".repeat(300)}.pdf`);
    expect(name.length).toBe(120);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("uniqueName", () => {
  it("numbers collisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qb-files-"));
    await writeFile(join(dir, "a.pdf"), "x");
    await writeFile(join(dir, "a (2).pdf"), "x");
    expect(await uniqueName(dir, "a.pdf")).toBe("a (3).pdf");
    expect(await uniqueName(dir, "b.pdf")).toBe("b.pdf");
  });
});

describe("mimeFor", () => {
  it("trusts magic bytes over the name", () => {
    expect(mimeFor("x.txt", Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(mimeFor("x.pdf", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(mimeFor("report.xlsx", Buffer.from("PK"))).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mimeFor("weird.bin", Buffer.from("zz"))).toBe("application/octet-stream");
  });
});
