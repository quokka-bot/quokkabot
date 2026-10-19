import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Alert, AppState, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AgentSummary, TakeoverFocusResponse } from "@quokkabot/shared";
import { withConsent } from "../consent";
import { useSignedIn } from "../session";
import { Viewer } from "./viewer";

type Field = NonNullable<TakeoverFocusResponse["field"]>;

// The agent's computer, full screen. "Take over" gives the owner the mouse and keyboard on the server; leaving this
// screen closes the live view, and a takeover nobody watches pauses the agent after 30 seconds. While the owner has
// control, a password or code field they tap on the computer can be typed here, in a native field where iOS offers
// saved passwords and SMS codes; the value goes into that field only, never through the agent.
export function ComputerScreen({ agentId }: { agentId: string }) {
  const { api, connection } = useSignedIn();
  const client = useQueryClient();
  const agent = useQuery({ queryKey: [connection.origin, "agent", agentId], queryFn: () => api.agent(agentId), refetchInterval: 5_000 });
  const [revision, setRevision] = useState(0);
  const [active, setActive] = useState(AppState.currentState === "active");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // In the background the live view closes, as it does when the screen closes.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  const inbox = useQuery({ queryKey: [connection.origin, "inbox"], queryFn: api.inbox });
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); await client.invalidateQueries({ queryKey: [connection.origin, "agent", agentId] }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const data: AgentSummary | undefined = agent.data;
  const holder = data?.computer.lease.holder;
  const running = data?.computer.state === "running";
  const killed = data?.computer.state === "killed";
  // A takeover the agent asked for ends with "I'm done", which tells the agent; one the owner started hands back.
  const asked = inbox.data?.items.find((item) => item.kind === "owner_request" && item.agentId === agentId && item.request.kind === "takeover" && item.request.answeredAt === null);
  const handBack = () => run(async () => {
    if (asked?.kind === "owner_request") await new Promise<void>((resolve, reject) => withConsent(connection.origin, agentId, () => { api.takeoverDone(asked.request.taskId).then(() => resolve(), reject); }));
    else await api.takeover(agentId, "return");
  });
  const stopEverything = () => Alert.alert("Stop everything?", "Closes this agent's network and stops its computer. Starting it again needs your passkey in the web app.", [
    { text: "Cancel", style: "cancel" },
    { text: "Stop everything", style: "destructive", onPress: () => void run(() => api.kill(agentId)) },
  ]);
  const status = killed ? "Stopped with the kill switch" : !running ? "The computer is off" : holder === "owner" ? "You have control" : holder === "agent" ? `${data?.name ?? "The agent"} is driving` : "Paused";
  return <SafeAreaView style={styles.page} edges={["top", "bottom"]}>
    <View style={styles.bar}>
      <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={12}><Text style={styles.barButton}>Done</Text></Pressable>
      <Text style={styles.status} accessibilityLiveRegion="polite" numberOfLines={1}>{status}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Stop everything" onPress={stopEverything} hitSlop={12} disabled={busy || killed}><Text style={[styles.barButton, styles.stop]}>Stop</Text></Pressable>
    </View>
    <View style={styles.viewer}>
      {running && active ? <Viewer key={`${agentId}:${revision}`} agentId={agentId} revision={revision} />
        : <View style={styles.center}>
          <Text style={styles.centerText}>{killed ? "Release the kill switch in the web app, with your passkey." : running ? "" : "The live view opens when the computer runs."}</Text>
          {!running && !killed && data && <Pressable accessibilityRole="button" style={styles.pill} disabled={busy} onPress={() => void run(() => api.startComputer(agentId))}><Text style={styles.pillText}>Start the computer</Text></Pressable>}
        </View>}
    </View>
    {running && <KeyboardAvoidingView behavior="padding">
      {holder === "owner" && <NativeFields agentId={agentId} />}
      <View style={styles.controls}>
        {holder === "owner"
          ? <Pressable accessibilityRole="button" style={styles.pill} disabled={busy} onPress={() => void handBack()}><Text style={styles.pillText}>{asked ? "I'm done, continue" : "Hand back"}</Text></Pressable>
          : <Pressable accessibilityRole="button" style={styles.pill} disabled={busy || killed} onPress={() => void run(() => api.takeover(agentId, "take"))}><Text style={styles.pillText}>Take over</Text></Pressable>}
        <Pressable accessibilityRole="button" style={[styles.pill, styles.quiet]} onPress={() => setRevision((value) => value + 1)}><Text style={styles.quietText}>Refresh view</Text></Pressable>
      </View>
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </KeyboardAvoidingView>}
  </SafeAreaView>;
}

// A native field for the password or code field focused on the computer. The owner taps the field in the live view,
// then "Type a password or code"; the field shows which site it types into. The check returns a handle for that one
// field, valid once and for a minute: if the page changed, a new field took focus or the takeover ended, nothing is
// typed and the owner checks again.
function NativeFields({ agentId }: { agentId: string }) {
  const { api } = useSignedIn();
  const [field, setField] = useState<Field | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const check = async () => {
    setBusy(true); setMessage(null);
    try {
      const focus = await api.takeoverFocus(agentId);
      setField(focus.field);
      if (focus.field === null) setMessage("Tap a password or code field on the computer first.");
      else setTimeout(() => input.current?.focus(), 50);
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const fill = async (submit: boolean) => {
    if (!field || value === "") return;
    setBusy(true); setMessage(null);
    try {
      // The handle names the exact field checked above; the computer types only into it, under this takeover.
      await api.takeoverFill(agentId, { kind: field.kind, value, focusId: field.focusId, submit });
      setMessage(submit ? "Typed and sent." : "Typed.");
      setField(null);
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : String(failure)); }
    finally { setValue(""); setBusy(false); }
  };
  // The value lives only in this field: cleared after every fill, and when the field closes.
  useEffect(() => () => setValue(""), []);
  if (!field) return <View style={styles.fields}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void check()} style={[styles.pill, styles.quiet]}><Text style={styles.quietText}>Type a password or code</Text></Pressable>
    {message && <Text style={styles.hint}>{message}</Text>}
  </View>;
  const host = new URL(field.origin).host;
  return <View style={styles.fields}>
    <Text style={styles.fieldLabel}>{field.kind === "password" ? `Password for ${host}` : `Code for ${host}`}</Text>
    <View style={styles.fieldRow}>
      <TextInput ref={input} style={styles.input} value={value} onChangeText={setValue} secureTextEntry={field.kind === "password"}
        textContentType={field.kind === "password" ? "password" : "oneTimeCode"} autoComplete={field.kind === "password" ? "current-password" : "one-time-code"}
        keyboardType={field.kind === "code" ? "number-pad" : "default"} autoCapitalize="none" autoCorrect={false} spellCheck={false}
        returnKeyType="send" onSubmitEditing={() => void fill(true)} accessibilityLabel={field.kind === "password" ? `Password for ${host}` : `Code for ${host}`} />
      <Pressable accessibilityRole="button" disabled={busy || value === ""} onPress={() => void fill(false)} style={styles.fillButton}><Text style={styles.fillText}>Type</Text></Pressable>
    </View>
    <Pressable accessibilityRole="button" onPress={() => { setField(null); setValue(""); }}><Text style={styles.hint}>Cancel</Text></Pressable>
    {message && <Text style={styles.hint}>{message}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000" },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10, gap: 12 },
  barButton: { color: "#fff", fontSize: 17, fontWeight: "600" },
  stop: { color: "#FF6B5E" },
  status: { flex: 1, color: "#ddd", fontSize: 15, textAlign: "center" },
  viewer: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { color: "#ddd", fontSize: 16, textAlign: "center" },
  controls: { flexDirection: "row", gap: 10, padding: 12, justifyContent: "center" },
  pill: { minHeight: 44, paddingHorizontal: 18, borderRadius: 999, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  pillText: { color: "#1C1C1C", fontSize: 16, fontWeight: "600" },
  quiet: { backgroundColor: "#2A2A2A" },
  quietText: { color: "#fff", fontSize: 15, fontWeight: "500" },
  fields: { paddingHorizontal: 12, paddingTop: 8, gap: 6, alignItems: "stretch" },
  fieldLabel: { color: "#fff", fontSize: 14, fontWeight: "600" },
  fieldRow: { flexDirection: "row", gap: 8 },
  input: { flex: 1, minHeight: 46, borderRadius: 12, paddingHorizontal: 12, fontSize: 18, backgroundColor: "#fff", color: "#1C1C1C" },
  fillButton: { minHeight: 46, paddingHorizontal: 18, borderRadius: 12, backgroundColor: "#7442D1", alignItems: "center", justifyContent: "center" },
  fillText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  hint: { color: "#bbb", fontSize: 14, textAlign: "center" },
  error: { color: "#FF6B5E", fontSize: 14, textAlign: "center", paddingBottom: 8 },
});
