import { useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { deviceName } from "../src/device";
import { appFetch } from "../src/session";
import { discover, serverOrigin, startLink } from "../src/sign-in";
import { Button, ErrorLine } from "../src/ui/kit";
import { colors } from "../src/ui/theme";

// A self-hosted server: its address, typed or scanned from Settings, Connect a phone. Then a link the owner approves
// with their passkey, or a code from the server's operator.
export default function Server() {
  const params = useLocalSearchParams<{ server?: string }>();
  const [address, setAddress] = useState(params.server ?? "");
  const [busy, setBusy] = useState<"link" | "code" | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (params.server) setAddress(params.server); }, [params.server]);
  const next = async (path: "link" | "code") => {
    setBusy(path); setError(null);
    try {
      const server = await discover(appFetch, serverOrigin(address));
      if (path === "code") { router.push({ pathname: "/code", params: server }); return; }
      const link = await startLink(appFetch, server.origin, deviceName());
      router.push({ pathname: "/link", params: { ...server, userCode: link.userCode, pollToken: link.pollToken, verifyUrl: link.verifyUrl } });
    } catch (failure) {
      setError(failure);
    } finally { setBusy(null); }
  };
  return <KeyboardAvoidingView style={styles.page} behavior="padding">
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Server address</Text>
      <TextInput style={styles.input} value={address} onChangeText={setAddress} placeholder="quokkabot.example.com" autoCapitalize="none" autoCorrect={false}
        keyboardType="url" textContentType="URL" returnKeyType="go" onSubmitEditing={() => void next("link")} accessibilityLabel="Server address" />
      <Button title="Scan the QR code" kind="light" disabled={busy !== null} onPress={() => router.push("/scan")} />
      <Text style={styles.help}>Settings, Connect a phone shows the code on your server.</Text>
      <View style={styles.actions}>
        <Button title="Continue" busy={busy === "link"} disabled={busy !== null || address.trim() === ""} onPress={() => void next("link")} />
        <Button title="I have a code" kind="quiet" busy={busy === "code"} disabled={busy !== null || address.trim() === ""} onPress={() => void next("code")} />
      </View>
      <ErrorLine error={error} />
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 12 },
  label: { fontSize: 14, fontWeight: "600", color: colors.textSoft },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.line, borderRadius: 12, paddingHorizontal: 14, fontSize: 17, backgroundColor: colors.card, color: colors.text },
  help: { fontSize: 14, color: colors.muted, textAlign: "center" },
  actions: { gap: 8, marginTop: 12 },
});
