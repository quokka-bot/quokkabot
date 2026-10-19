import type { ReactNode } from "react";
import { ActionSheetIOS, Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as MailComposer from "expo-mail-composer";
import * as WebBrowser from "expo-web-browser";
import { REACTION_EMOJIS, type ReactionEmoji } from "@quokkabot/shared";
import { SUPPORT_EMAIL, SUPPORT_URL } from "../device";
import { useSignedIn } from "../session";
import { ErrorLine } from "../ui/kit";
import { colors } from "../ui/theme";
import { reportResponse } from "./report";
import { useAction } from "./use-action";

export function Bubble({ agentId, from, children, text, taskId, seq, live = false, reaction }: {
  agentId: string; from: "owner" | "agent"; children: ReactNode; text: string; taskId: string;
  seq?: number | null; live?: boolean; reaction?: ReactionEmoji;
}) {
  const { api, connection } = useSignedIn();
  const react = useAction(agentId, (choice: ReactionEmoji) => api.react(taskId, seq as number, choice === reaction ? null : choice));
  const local = useAction(agentId, async (action: "copy" | "report") => {
    if (action === "copy") await Clipboard.setStringAsync(text);
    else await reportResponse({ text, origin: connection.origin, taskId, email: SUPPORT_EMAIL, supportUrl: SUPPORT_URL }, {
      mailAvailable: MailComposer.isAvailableAsync, compose: MailComposer.composeAsync,
      copy: Clipboard.setStringAsync, open: WebBrowser.openBrowserAsync,
    });
  }, false);
  const menu = () => {
    const emojis = seq == null ? [] : [...REACTION_EMOJIS];
    const options = [...emojis, "Copy", "Report this response", "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: options.length - 1 }, index => {
      const emoji = emojis[index];
      if (emoji) react.run(emoji);
      else if (index === emojis.length) local.run("copy");
      else if (index === emojis.length + 1) local.run("report");
    });
  };
  const content = <>
    {children}{live && <Text accessibilityLabel="Writing" style={styles.writing}>•••</Text>}
    {reaction && <View style={styles.badge}><Text accessibilityLabel={`${from === "agent" ? "Your" : "Agent"} reaction: ${reaction}`} style={styles.emoji}>{reaction}</Text></View>}
  </>;
  return <View style={[styles.row, from === "owner" ? styles.ownerRow : styles.agentRow]}>
    {from === "agent" ? <Pressable accessibilityRole="text" accessibilityLabel={text} accessibilityHint="Long press for reactions, copy or report"
      accessibilityActions={[{ name: "longpress", label: "Message actions" }]} onAccessibilityAction={menu} onLongPress={menu}
      style={[styles.bubble, styles.agent, reaction && styles.reacted]}>{content}</Pressable>
      : <View style={[styles.bubble, styles.owner, reaction && styles.reacted]}>{content}</View>}
    <ErrorLine error={react.error ?? local.error} />
  </View>;
}

export const bubbleStyles = StyleSheet.create({
  ownerText: { fontSize: 16, lineHeight: 23, color: "#fff" }, agentText: { fontSize: 16, lineHeight: 23, color: colors.text },
});
const styles = StyleSheet.create({
  row: { marginVertical: 5 }, ownerRow: { alignItems: "flex-end" }, agentRow: { alignItems: "flex-start" },
  bubble: { maxWidth: "92%", borderRadius: 20, paddingHorizontal: 15, paddingVertical: 11, flexShrink: 1 },
  owner: { backgroundColor: colors.purple, borderBottomRightRadius: 6 }, agent: { backgroundColor: colors.bubble, borderBottomLeftRadius: 6 },
  writing: { color: colors.muted, fontSize: 16, marginTop: 4 }, reacted: { marginBottom: 14 },
  badge: { position: "absolute", right: 8, bottom: -14, borderRadius: 20, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 7, paddingVertical: 2 },
  emoji: { fontSize: 16 },
});
