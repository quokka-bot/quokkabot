import { useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { StyleSheet, Switch, Text, View } from "react-native";
import { useSignedIn } from "./session";
import { colors } from "./ui/theme";

// Permission to send to an agent's AI provider (App Review 5.1.2(i)): asked before this phone sends the agent
// anything (a task, a reply, a login, a site decision, a hand-back), per server and agent. A new disclosure version
// asks again. Kept in the app's folder, not the Keychain: it holds no secret.
export const DISCLOSURE_VERSION = "2026-10-19";
export const PROVIDER = { name: "Claude by Anthropic", company: "Anthropic", privacyUrl: "https://www.anthropic.com/legal/privacy" } as const;

const file = new File(Paths.document, "ai-consent.json");
let granted: Record<string, string> = read();
const listeners = new Set<() => void>();

function read(): Record<string, string> {
  if (!file.exists) return {};
  const parsed: unknown = JSON.parse(file.textSync());
  if (typeof parsed !== "object" || parsed === null) throw new Error("ai-consent.json is damaged");
  return parsed as Record<string, string>;
}
function write(next: Record<string, string>): void {
  if (!file.exists) file.create();
  file.write(JSON.stringify(next));
  granted = next;
  for (const listener of listeners) listener();
}
const key = (origin: string, agentId: string) => `${origin}|${agentId}`;

export function hasConsent(origin: string, agentId: string): boolean {
  return granted[key(origin, agentId)] === DISCLOSURE_VERSION;
}
export function grantConsent(origin: string, agentId: string): void {
  write({ ...granted, [key(origin, agentId)]: DISCLOSURE_VERSION });
}
export function revokeConsent(origin: string, agentId: string): void {
  const next = { ...granted };
  delete next[key(origin, agentId)];
  write(next);
}

export function useConsent(agentId: string): boolean {
  const { connection } = useSignedIn();
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => hasConsent(connection.origin, agentId));
}

// Runs `send` when the owner has allowed this agent's provider, else opens the permission screen first.
export function withConsent(origin: string, agentId: string, send: () => void): void {
  if (hasConsent(origin, agentId)) { send(); return; }
  router.push({ pathname: "/consent/[agentId]", params: { agentId } });
}

export function ConsentSettings() {
  const { api, connection } = useSignedIn();
  const agents = useQuery({ queryKey: [connection.origin, "agents"], queryFn: api.agents });
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => granted);
  if (!agents.data || agents.data.agents.length === 0) return null;
  return <View style={styles.section}>
    <Text style={styles.title}>AI provider</Text>
    <View style={styles.card}>
      {agents.data.agents.map((agent) => {
        const on = hasConsent(connection.origin, agent.id);
        return <View key={agent.id} style={styles.row}>
          <View style={styles.text}><Text style={styles.name}>{agent.name}</Text><Text style={styles.meta}>{PROVIDER.name}</Text></View>
          <Switch accessibilityLabel={`Send to ${PROVIDER.name} for ${agent.name}`} value={on}
            onValueChange={(value) => value ? grantConsent(connection.origin, agent.id) : revokeConsent(connection.origin, agent.id)} />
        </View>;
      })}
    </View>
    <Text style={styles.help}>Off: this phone sends nothing to that agent. Tasks already running continue until they end or you stop them.</Text>
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  title: { fontSize: 13, fontWeight: "600", color: colors.muted, textTransform: "uppercase", marginLeft: 4 },
  card: { borderRadius: 14, backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 14 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 56, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  text: { flex: 1 },
  name: { fontSize: 16, color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  help: { fontSize: 13, color: colors.muted, marginHorizontal: 4 },
});
