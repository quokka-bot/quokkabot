import { Fragment } from "react";
import { StyleSheet, Text, View } from "react-native";
import { markdownBlocks, type MarkdownInline } from "@quokkabot/client";
import { colors } from "../ui/theme";

function inline(tokens: MarkdownInline[]) {
  return tokens.map((token, index) => {
    switch (token.kind) {
      case "bold": return <Text key={index} style={styles.bold}>{token.text}</Text>;
      case "italic": return <Text key={index} style={styles.italic}>{token.text}</Text>;
      case "code": return <Text key={index} style={styles.code}>{token.text}</Text>;
      case "link": return `${token.text} (${token.url})`;
      case "text": return token.text;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  return <View style={styles.blocks}>{markdownBlocks(text).map((block, index) => block.kind === "paragraph"
    ? <Text key={index} style={styles.text}>{block.lines.map((line, i) => <Fragment key={i}>{i > 0 ? "\n" : ""}{inline(line)}</Fragment>)}</Text>
    : <View key={index} style={styles.list}>{block.items.map((item, i) => <View key={i} style={styles.row}>
      <Text style={styles.text}>{block.ordered ? `${i + 1}.` : "•"}</Text><Text style={[styles.text, styles.item]}>{inline(item)}</Text>
    </View>)}</View>)}</View>;
}

const styles = StyleSheet.create({
  blocks: { gap: 10 }, text: { color: colors.text, fontSize: 16, lineHeight: 23 },
  bold: { fontWeight: "700" }, italic: { fontStyle: "italic" }, code: { fontFamily: "Menlo", backgroundColor: "#E3E3E3" },
  list: { gap: 5 }, row: { flexDirection: "row", gap: 8 }, item: { flex: 1 },
});
