import { useRef, useState, type ComponentRef } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { AgentSummary, OwnerRequest, Task } from "@quokkabot/shared";
import { useConsent } from "../consent";
import { useSignedIn } from "../session";
import { Button, ErrorLine } from "../ui/kit";
import { colors } from "../ui/theme";
import { composerState, sendDraft } from "./composer-state";
import { draftId } from "./id";
import { useAction } from "./use-action";

// `onSent`: the server accepted the message. The send calls the `onSent` it started with.
export function Composer({ agent, task, ready, openQuestion, waiting, startNew, onCreated, onSent }: {
  agent: AgentSummary; task: Task | null; ready: boolean; openQuestion: OwnerRequest | null; waiting: boolean;
  startNew: () => void; onCreated: (task: Task) => void; onSent: () => void;
}) {
  const { api } = useSignedIn();
  const consented = useConsent(agent.id);
  const [text, setText] = useState("");
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const sending = useRef(false);
  const [draftKey, setDraftKey] = useState(draftId);
  const state = composerState(agent.name, task, waiting, openQuestion);
  const send = useAction(agent.id, async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      const sent = await sendDraft(api, { agentId: agent.id, task, waiting, ready, text, draftKey });
      if (!sent) return;
      if (task === null) onCreated(sent);
      onSent();
      setText("");
      setDraftKey(draftId());
    } finally { sending.current = false; }
  });
  const stop = useAction(agent.id, async () => { if (task) await api.cancel(task.id); }, false);
  return <View style={styles.composer}>
    <ErrorLine error={send.error ?? stop.error} />
    <View style={styles.box}>
      <Pressable accessibilityRole="button" accessibilityLabel="New task" onPress={() => { startNew(); input.current?.focus(); }} style={styles.newTask}>
        <Text style={styles.plus}>+</Text>
      </Pressable>
      <TextInput ref={input} accessibilityLabel={task === null ? "New task" : "Message"}
        accessibilityHint={consented ? undefined : "Review AI consent before sending"} style={styles.input}
        multiline maxLength={20000} value={text} onChangeText={setText} placeholder={state.placeholder} placeholderTextColor={colors.muted}
        editable={!state.running && ready && !send.isPending} />
      {state.running ? <Button title="Stop" kind="light" onPress={() => stop.run()} busy={stop.isPending} />
        : <Button title="Send" onPress={() => send.run()} busy={send.isPending} disabled={!ready || !text.trim()} />}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  composer: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6, backgroundColor: colors.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  box: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  newTask: { minWidth: 44, minHeight: 46, justifyContent: "center", alignItems: "center" }, plus: { color: colors.text, fontSize: 28 },
  input: { flex: 1, minHeight: 46, maxHeight: 180, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 20, backgroundColor: colors.sidebar, color: colors.text, fontSize: 16 },
});
