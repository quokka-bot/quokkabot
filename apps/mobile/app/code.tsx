import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { KeyboardAvoidingView, StyleSheet, Text, TextInput } from "react-native";
import { PairingCode } from "@quokkabot/shared";
import { deviceName } from "../src/device";
import { useSession, appFetch } from "../src/session";
import { signInWithCode } from "../src/sign-in";
import { Button, ErrorLine } from "../src/ui/kit";
import { colors } from "../src/ui/theme";

// A code from the server's operator (`pairing-code` on the server), for a server nobody opens in a browser.
export default function Code() {
  const params = useLocalSearchParams<{ origin: string; viewOrigin: string }>();
  const { signIn } = useSession();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = PairingCode.safeParse(code).success;
  const submit = async () => {
    setBusy(true); setError(null);
    try { await signIn(await signInWithCode(appFetch, { origin: params.origin, viewOrigin: params.viewOrigin }, code, deviceName())); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  return <KeyboardAvoidingView style={styles.page} behavior="padding">
    <Text style={styles.lead}>Type the code printed on {new URL(params.origin).host}.</Text>
    <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="XXXX-XXXX-XXXX" autoCapitalize="characters" autoCorrect={false}
      autoComplete="off" textContentType="none" accessibilityLabel="Code" returnKeyType="go" onSubmitEditing={() => { if (valid) void submit(); }} />
    <Button title="Sign in" busy={busy} disabled={!valid} onPress={() => void submit()} />
    <ErrorLine error={error} />
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 24, gap: 16, backgroundColor: colors.background },
  lead: { fontSize: 16, color: colors.textSoft, textAlign: "center", marginTop: 12 },
  input: { minHeight: 56, borderWidth: 1, borderColor: colors.line, borderRadius: 14, paddingHorizontal: 14, fontSize: 24, letterSpacing: 2, textAlign: "center", backgroundColor: colors.card, color: colors.text },
});
