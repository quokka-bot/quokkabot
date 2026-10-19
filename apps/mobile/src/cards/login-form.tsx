import { useState } from "react";
import { StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SaveLoginRequest, UpdateLoginRequest, siteLabel, type LoginView } from "@quokkabot/shared";
import { loginSites, requireLoginFields, validateTotp } from "@quokkabot/client";
import { useAction } from "../chat/use-action";
import { useSignedIn } from "../session";
import { Button, ErrorLine } from "../ui/kit";
import { colors } from "../ui/theme";

export function LoginForm({ agentId, login, initialSite = "", initialName = "", onSaved, onCancel }: {
  agentId: string; login?: LoginView; initialSite?: string; initialName?: string; onSaved: () => void; onCancel: () => void;
}) {
  const { api } = useSignedIn();
  const [name, setName] = useState(login?.name ?? initialName);
  const [sites, setSites] = useState(login?.sites.map(siteLabel).join(", ") ?? initialSite);
  const [username, setUsername] = useState(login?.username ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [totp, setTotp] = useState("");
  const [removeTotp, setRemoveTotp] = useState(false);
  const compact = !login && initialSite !== "";
  const [details, setDetails] = useState(!compact);
  const [withTotp, setWithTotp] = useState(!compact);
  const save = useAction(agentId, async () => {
    // An existing login keeps its password when the field stays empty.
    requireLoginFields({ name, username, ...(login ? {} : { password }) });
    const common = { name: name.trim(), sites: loginSites(sites), username };
    const twoFactor = !removeTotp && totp.trim() ? validateTotp(totp) : undefined;
    if (login) {
      await api.updateLogin(login.id, UpdateLoginRequest.parse({ ...common, ...(password ? { password } : {}),
        ...(removeTotp ? { totp: null } : twoFactor ? { totp: twoFactor } : {}) }));
    } else {
      await api.saveLogin(agentId, SaveLoginRequest.parse({ ...common, password, ...(twoFactor ? { totp: twoFactor } : {}) }));
    }
    setPassword(""); setTotp(""); setShowPassword(false);
    onSaved();
  });
  return <View style={styles.form}>
    {details ? <>
      <Text style={styles.label}>Name</Text>
      <TextInput accessibilityLabel="Name" style={styles.input} value={name} onChangeText={setName} maxLength={80} editable={!save.isPending} />
      <Text style={styles.label}>Sites</Text>
      <TextInput accessibilityLabel="Sites" style={styles.input} value={sites} onChangeText={setSites} placeholder="example.com" autoCapitalize="none" autoCorrect={false} editable={!save.isPending} />
    </> : <View><Text style={styles.meta}>For {sites}</Text><Button title="change" kind="quiet" onPress={() => setDetails(true)} /></View>}
    <Text style={styles.label}>{compact ? "Email or username" : "Username"}</Text>
    <TextInput accessibilityLabel={compact ? "Email or username" : "Username"} style={styles.input} value={username} onChangeText={setUsername}
      textContentType="username" autoCapitalize="none" autoCorrect={false} maxLength={320} editable={!save.isPending} />
    <Text style={styles.label}>{login ? "New password (leave empty to keep saved password)" : "Password"}</Text>
    <TextInput accessibilityLabel={login ? "New password (leave empty to keep saved password)" : "Password"} style={styles.input} value={password}
      onChangeText={setPassword} secureTextEntry={!showPassword} textContentType="password" autoCapitalize="none" autoCorrect={false} maxLength={500} editable={!save.isPending} />
    <Button title={showPassword ? "Hide password" : "Show password"} kind="quiet" onPress={() => setShowPassword(value => !value)} disabled={save.isPending} />
    {withTotp ? <>
      <Text style={styles.label}>2FA secret (optional)</Text>
      <TextInput accessibilityLabel="2FA secret (optional)" style={styles.input} value={totp} onChangeText={setTotp} secureTextEntry autoCapitalize="none"
        autoCorrect={false} maxLength={1000} editable={!save.isPending && !removeTotp} />
      <Text style={styles.meta}>Find the base32 secret or otpauth:// URI on the site’s 2FA setup page, usually under “Can’t scan the QR code?”.{login?.hasTotp && " Leave empty to keep saved 2FA."}</Text>
    </> : <Button title="Add an authenticator code" kind="quiet" onPress={() => setWithTotp(true)} />}
    {login?.hasTotp && <View style={styles.switchRow}><Text style={styles.switchText}>Remove saved 2FA</Text>
      <Switch accessibilityLabel="Remove saved 2FA" value={removeTotp} onValueChange={setRemoveTotp} disabled={save.isPending} /></View>}
    <View style={styles.actions}><Button title={save.isPending ? "Saving…" : "Save login"} onPress={() => save.run()} busy={save.isPending} />
      <Button title="Cancel" kind="light" onPress={onCancel} disabled={save.isPending} /></View>
    <ErrorLine error={save.error} />
  </View>;
}

const styles = StyleSheet.create({
  form: { gap: 8 }, label: { color: colors.text, fontSize: 15, fontWeight: "500" },
  input: { fontSize: 16, color: colors.text, backgroundColor: colors.background, borderColor: colors.line, borderWidth: 1, borderRadius: 10, padding: 12 },
  meta: { color: colors.muted, fontSize: 13 }, actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 10 }, switchText: { flex: 1, fontSize: 15, color: colors.text },
});
