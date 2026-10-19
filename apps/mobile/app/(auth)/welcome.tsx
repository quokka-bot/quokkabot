import { useState } from "react";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as Passkeys from "react-native-passkeys";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { deviceName, passkeyDomain, PRIVACY_URL, SUPPORT_URL } from "../../src/device";
import { useSession, appFetch } from "../../src/session";
import { discover, signInWithPasskey } from "../../src/sign-in";
import { AgentAvatar, Button, ErrorLine } from "../../src/ui/kit";
import { colors } from "../../src/ui/theme";

export default function Welcome() {
  const { session, signIn } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const domain = passkeyDomain();
  const passkey = async () => {
    setBusy(true); setError(null);
    try {
      const server = await discover(appFetch, `https://${domain}`);
      await signIn(await signInWithPasskey(appFetch, server, deviceName(), async (options) => {
        const assertion = await Passkeys.get(options as Parameters<typeof Passkeys.get>[0]);
        if (assertion === null) throw new Error("Sign-in was cancelled.");
        return assertion;
      }));
    } catch (failure) {
      setError(failure);
    } finally { setBusy(false); }
  };
  return <SafeAreaView style={styles.page}>
    <View style={styles.top}>
      <AgentAvatar index={1} size={72} />
      <Text style={styles.title}>Quokka Bot</Text>
      <Text style={styles.lead}>Your agents and their computers. Answer their questions, approve sites and logins, and take over the computer when only a person can.</Text>
    </View>
    <View style={styles.actions}>
      {session.state === "signed-out" && session.reason && <Text style={styles.reason}>{session.reason}</Text>}
      <Button title={`Sign in to ${domain}`} busy={busy} onPress={() => void passkey()} />
      <Button title="Connect to your server" kind="light" disabled={busy} onPress={() => router.push("/server")} />
      <ErrorLine error={error} />
      <View style={styles.links}>
        <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(PRIVACY_URL)}><Text style={styles.link}>Privacy</Text></Pressable>
        <Pressable accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(SUPPORT_URL)}><Text style={styles.link}>Support</Text></Pressable>
      </View>
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 24, justifyContent: "space-between", backgroundColor: colors.background },
  top: { alignItems: "center", gap: 14, marginTop: 64 },
  title: { fontSize: 30, fontWeight: "700", color: colors.text },
  lead: { fontSize: 16, lineHeight: 23, color: colors.textSoft, textAlign: "center" },
  actions: { gap: 12 },
  reason: { fontSize: 15, color: colors.amber, textAlign: "center" },
  links: { flexDirection: "row", justifyContent: "center", gap: 24, marginTop: 8 },
  link: { color: colors.muted, fontSize: 14 },
});
