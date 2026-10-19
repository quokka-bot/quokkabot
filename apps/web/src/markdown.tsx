import type { ReactNode } from "react";

// A small Markdown subset for the agent's messages, rendered as React elements (never as HTML): paragraphs, bullet
// and numbered lists, **bold**, *italic* and `code`. The agent's text is untrusted (a page can put words in its mouth),
// so links stay plain text: [label](url) shows as "label (url)" and nothing in a message is clickable.

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyBase}-${index++}`;
    if (match[2] !== undefined) out.push(<strong key={key}>{match[2]}</strong>);
    else if (match[3] !== undefined) out.push(<em key={key}>{match[3]}</em>);
    else if (match[4] !== undefined) out.push(<code key={key}>{match[4]}</code>);
    else if (match[5] !== undefined && match[6] !== undefined) out.push(`${match[5]} (${match[6]})`);
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const key = `p${blocks.length}`;
      blocks.push(<p key={key}>{paragraph.flatMap((line, i) => i === 0 ? inline(line, `${key}-${i}`) : [<br key={`${key}-br${i}`} />, ...inline(line, `${key}-${i}`)])}</p>);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const key = `l${blocks.length}`;
      const items = list.items.map((item, i) => <li key={`${key}-${i}`}>{inline(item, `${key}-${i}`)}</li>);
      blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      list = null;
    }
  };
  for (const raw of lines) {
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
  return <div className="markdown">{blocks}</div>;
}
