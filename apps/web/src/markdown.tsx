import type { ReactNode } from "react";
import { markdownBlocks, type MarkdownInline } from "@quokkabot/client";

// Agent text is untrusted. Links stay plain text and nothing in a message is clickable.
function inline(tokens: MarkdownInline[], keyBase: string): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyBase}-${index}`;
    switch (token.kind) {
      case "bold": return <strong key={key}>{token.text}</strong>;
      case "italic": return <em key={key}>{token.text}</em>;
      case "code": return <code key={key}>{token.text}</code>;
      case "link": return `${token.text} (${token.url})`;
      case "text": return token.text;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{markdownBlocks(text).map((block, index) => {
    if (block.kind === "paragraph") {
      const key = `p${index}`;
      return <p key={key}>{block.lines.flatMap((line, i) => i === 0 ? inline(line, `${key}-${i}`) : [<br key={`${key}-br${i}`} />, ...inline(line, `${key}-${i}`)])}</p>;
    }
    const key = `l${index}`;
    const items = block.items.map((item, i) => <li key={`${key}-${i}`}>{inline(item, `${key}-${i}`)}</li>);
    return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
  })}</div>;
}
