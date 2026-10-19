export type MarkdownInline =
  | { kind: "text" | "bold" | "italic" | "code"; text: string }
  | { kind: "link"; text: string; url: string };

export type MarkdownBlock =
  | { kind: "paragraph"; lines: MarkdownInline[][] }
  | { kind: "list"; ordered: boolean; items: MarkdownInline[][] };

// Tokens only, with no HTML interpretation or URL navigation. Both clients display links as label (url).
export function markdownInline(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  // Link text stops at any bracket and a URL at any bracket or parenthesis, so a failed match never rescans the line.
  const pattern = /(\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`|\[([^[\]]+)\]\((https?:\/\/[^()[\]\s]+)\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    if (match[2] !== undefined) out.push({ kind: "bold", text: match[2] });
    else if (match[3] !== undefined) out.push({ kind: "italic", text: match[3] });
    else if (match[4] !== undefined) out.push({ kind: "code", text: match[4] });
    else if (match[5] !== undefined && match[6] !== undefined) out.push({ kind: "link", text: match[5], url: match[6] });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function markdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph.map(markdownInline) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items.map(markdownInline) });
      list = null;
    }
  };
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)?.[1] ?? "");
    } else if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      paragraph.push(`**${heading[1] ?? ""}**`);
      flushParagraph();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
