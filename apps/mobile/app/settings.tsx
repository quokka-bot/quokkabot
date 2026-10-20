import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import Constants from "expo-constants";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { OwnerName, type Me } from "@quokkabot/shared";
import { PRIVACY_URL, SUPPORT_URL } from "../src/device";
import { useSession, useSignedIn } from "../src/session";
import { Button, ErrorLine } from "../src/ui/kit";
import { colors } from "../src/ui/theme";
import { ConsentSettings } from "../src/consent";

export default function Settings() {
  const { api, connection } = useSignedIn();
  const { signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const devices = useQuery({ queryKey: [connection.origin, "sessions"], queryFn: api.sessions });
  const leave = () => Alert.alert("Sign out of this phone?", `Signs this phone out of ${new URL(connection.origin).host}. Your agents keep working.`, [
    { text: "Cancel", style: "cancel" },
    { text: "Sign out", style: "destructive", onPress: () => void (async () => {
      setBusy(true); setError(null);
      // Signed out on the server first; offline, the phone forgets the token and Settings on the web can revoke it.
      try { await api.logout(); } catch (failure) { setError(failure); }
      await signOut();
    })() },
  ]);
  return <ScrollView style={styles.page} contentContainerStyle={styles.content}>
    <Section title="Server">
      <Row label={new URL(connection.origin).host} />
    </Section>
    <OwnerNameSection />
    <Section title="Signed-in devices">
      {devices.data?.sessions.map((device) => <Row key={device.id} label={device.deviceName} detail={device.current ? "This phone" : device.client === "phone" ? "iPhone app" : device.client === "desktop" ? "Mac app" : "Web app"} />)}
      <ErrorLine error={devices.error} />
      <Text style={styles.help}>Sign other devices out in the web app, Settings.</Text>
    </Section>
    <ConsentSettings />
    <Section title="About">
      <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(PRIVACY_URL)}><Row label="Privacy policy" chevron /></Pressable>
      <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(SUPPORT_URL)}><Row label="Support" chevron /></Pressable>
      <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync("https://github.com/quokka-bot/quokkabot")}><Row label="Source code (MIT)" chevron /></Pressable>
      <Row label="Version" detail={String(Constants.expoConfig?.version ?? "")} />
    </Section>
    <Button title="Sign out of this phone" kind="light" busy={busy} onPress={leave} />
    <ErrorLine error={error} />
  </ScrollView>;
}

// The owner's name, the same one the web and Mac apps show and change.
function OwnerNameSection() {
  const { api, connection } = useSignedIn();
  const client = useQueryClient();
  const me = useQuery({ queryKey: [connection.origin, "me"], queryFn: api.me });
  return <Section title="Your name">
    {me.data ? <OwnerNameForm initial={me.data.ownerName} save={async (name) => {
      const saved = await api.setOwnerName(name);
      client.setQueryData<Me>([connection.origin, "me"], saved);
      return saved.ownerName;
    }} /> : <ErrorLine error={me.error} />}
  </Section>;
}

function OwnerNameForm({ initial, save }: { initial: string; save: (name: string) => Promise<string> }) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    const parsed = OwnerName.safeParse(value);
    setSaved(false);
    if (!parsed.success) { setError(new Error(parsed.error.issues[0]?.message ?? "Enter your name.")); return; }
    setBusy(true); setError(null);
    try { setValue(await save(parsed.data)); setSaved(true); } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  return <View style={styles.nameForm}>
    <TextInput style={styles.input} value={value} onChangeText={(text) => { setValue(text); setSaved(false); }} placeholder="Your name" autoComplete="name"
      textContentType="name" returnKeyType="done" onSubmitEditing={() => void submit()} accessibilityLabel="Your name" />
    <Button title="Save name" kind="light" busy={busy} disabled={value.trim() === ""} onPress={() => void submit()} />
    {saved && <Text accessibilityRole="text" style={styles.help}>Name saved.</Text>}
    <ErrorLine error={error} />
  </View>;
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.card}>{children}</View>
  </View>;
}

export function Row({ label, detail, chevron = false }: { label: string; detail?: string; chevron?: boolean }) {
  return <View style={styles.row}>
    <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
    {detail !== undefined && <Text style={styles.rowDetail}>{detail}</Text>}
    {chevron && <Text style={styles.chevron}>›</Text>}
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 20, paddingBottom: 48 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "600", color: colors.muted, textTransform: "uppercase", marginLeft: 4 },
  card: { borderRadius: 14, backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 14 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 48, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowLabel: { flex: 1, fontSize: 16, color: colors.text },
  rowDetail: { fontSize: 15, color: colors.muted },
  chevron: { fontSize: 22, color: colors.muted },
  help: { fontSize: 13, color: colors.muted, paddingVertical: 10 },
  nameForm: { gap: 10, paddingVertical: 12 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 12, fontSize: 16, backgroundColor: colors.background, color: colors.text },
});
