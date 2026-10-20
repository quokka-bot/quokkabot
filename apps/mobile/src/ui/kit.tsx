import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "./theme";

export { AgentAvatar, ProductMark } from "./agent-avatar";

// Small building blocks shared by every screen: buttons in the web app's pill style, an error line, the avatars.

export function Button({ title, onPress, kind = "dark", disabled = false, busy = false, style }: {
  title: string; onPress: () => void; kind?: "dark" | "light" | "quiet"; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || busy;
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: off, busy }} disabled={off} onPress={onPress}
    style={({ pressed }) => [styles.button, kind === "dark" ? styles.dark : kind === "light" ? styles.light : styles.quiet, off && styles.off, pressed && styles.pressed, style]}>
    {busy ? <ActivityIndicator color={kind === "dark" ? "#fff" : colors.text} /> : <Text style={[styles.buttonText, kind === "dark" && styles.darkText, kind === "quiet" && styles.quietText]}>{title}</Text>}
  </Pressable>;
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <Text accessibilityRole="alert" style={styles.error}>{error instanceof Error ? error.message : String(error)}</Text>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <Text style={styles.notice}>{children}</Text>;
}

const styles = StyleSheet.create({
  button: { minHeight: 46, paddingHorizontal: 20, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  dark: { backgroundColor: colors.text },
  light: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  quiet: { backgroundColor: "transparent" },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  buttonText: { fontSize: 16, fontWeight: "600", color: colors.text },
  darkText: { color: "#fff" },
  quietText: { color: colors.purple, fontWeight: "500" },
  error: { color: colors.red, fontSize: 14, marginVertical: 6 },
  notice: { color: colors.muted, fontSize: 13, textAlign: "center", marginVertical: 8 },
});
