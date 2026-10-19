import { expect, it } from "vitest";
import { markdownBlocks, markdownInline } from "../src/index.js";

const plain = (text: string) => ({ kind: "text", text });
it("parses bold, italic, code and inert HTTP links in order", () => {
  expect(markdownInline("A **bold** *italic* `code` [site](https://example.com) end")).toEqual([
    plain("A "), { kind: "bold", text: "bold" }, plain(" "), { kind: "italic", text: "italic" }, plain(" "),
    { kind: "code", text: "code" }, plain(" "), { kind: "link", text: "site", url: "https://example.com" }, plain(" end"),
  ]);
});
it("keeps HTML, dangerous schemes, unsupported markup and incomplete delimiters as literal text", () => {
  const text = '<script>alert(1)</script> [run](javascript:alert(1)) [file](file:///etc/passwd) **unfinished _word_';
  expect(markdownInline(text)).toEqual([plain(text)]);
  expect(markdownInline("")).toEqual([]);
  expect(markdownInline("* leading*")).toEqual([plain("* leading*")]);
});
it("preserves the web subset's nonrecursive inline parsing", () => {
  expect(markdownInline("**use `code`** and `**literal**`")).toEqual([
    { kind: "bold", text: "use `code`" }, plain(" and "), { kind: "code", text: "**literal**" },
  ]);
});
it("keeps paragraph line breaks, leading spaces, CRLF and trailing whitespace behavior", () => {
  expect(markdownBlocks("  First  \r\nsecond\r\n\r\nlast\n")).toEqual([
    { kind: "paragraph", lines: [[plain("  First")], [plain("second")]] },
    { kind: "paragraph", lines: [[plain("last")]] },
  ]);
});
it("splits lists when order changes and treats numbering as consecutive list items", () => {
  expect(markdownBlocks("Intro\n- **one**\n* two\n • three\n7. first\n9) second\nTail")).toEqual([
    { kind: "paragraph", lines: [[plain("Intro")]] },
    { kind: "list", ordered: false, items: [[{ kind: "bold", text: "one" }], [plain("two")], [plain("three")]] },
    { kind: "list", ordered: true, items: [[plain("first")], [plain("second")]] },
    { kind: "paragraph", lines: [[plain("Tail")]] },
  ]);
});
it("renders headings as their own bold paragraph, as the existing web renderer does", () => {
  expect(markdownBlocks("Before\n## Heading\nAfter\n\n###### Six\n####### Seven")).toEqual([
    { kind: "paragraph", lines: [[plain("Before")]] },
    { kind: "paragraph", lines: [[{ kind: "bold", text: "Heading" }]] },
    { kind: "paragraph", lines: [[plain("After")]] },
    { kind: "paragraph", lines: [[{ kind: "bold", text: "Six" }]] },
    { kind: "paragraph", lines: [[plain("####### Seven")]] },
  ]);
});
it("flushes adjacent lists on a blank line and handles empty input", () => {
  expect(markdownBlocks("- first\n\n- second")).toEqual([
    { kind: "list", ordered: false, items: [[plain("first")]] }, { kind: "list", ordered: false, items: [[plain("second")]] },
  ]);
  expect(markdownBlocks(" \n\r\n")).toEqual([]);
});
