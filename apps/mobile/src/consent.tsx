import { useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";
import { useMutation, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { StyleSheet, Switch, Text, View } from "react-native";
import { AGENT_PROVIDER, AI_CONSENT_ERROR } from "@quokkabot/shared";
import { ApiFailure, type Api } from "./api";
import { consentVersion, forgetConsent, hasConsent, PROVIDER, subscribeConsent } from "./consent-store";
import { useSignedIn } from "./session";
import { ErrorLine } from "./ui/kit";
import { colors } from "./ui/theme";

export { hasConsent, PROVIDER } from "./consent-store";

// Permission to send to an agent's AI provider (App Review 5.1.2(i)): asked before this phone sends the agent
// anything (a task, a reply, a login, a site decision, a hand-back). The answer is the server's record, shared with the
// web and Mac apps; withdrawing it on any of them stops the agent's queued and running tasks on the server.

// Earlier builds kept the answer in this file on the phone; the server's record replaced it.
const legacyFile = new File(Paths.document, "ai-consent.json");
if (legacyFile.exists) legacyFile.delete();

export function useConsent(agentId: string): boolean {
  const { connection } = useSignedIn();
  useSyncExternalStore(subscribeConsent, consentVersion);
  return hasConsent(connection.origin, agentId);
}

const askConsent = (agentId: string) => router.push({ pathname: "/consent/[agentId]", params: { agentId } });

// Runs `send` when the owner has allowed this agent's provider, else opens the permission screen first.
export function withConsent(origin: string, agentId: string, send: () => void): void {
  if (hasConsent(origin, agentId)) { send(); return; }
  askConsent(agentId);
}

// The server refused a send for want of permission (another app withdrew it since this phone last looked): the phone
// asks again. Returns whether the error was that refusal.
export function consentRefused(origin: string, agentId: string, error: unknown): boolean {
  if (!(error instanceof ApiFailure) || error.code !== AI_CONSENT_ERROR) return false;
  forgetConsent(origin, agentId);
  askConsent(agentId);
  return true;
}

// The Settings switch. On opens the permission screen, the same one a first send opens, and only its Allow button
// grants; off withdraws at once on the server.
export async function changeConsent(api: Pick<Api, "setAiConsent">, agentId: string, on: boolean): Promise<void> {
  if (on) { askConsent(agentId); return; }
  await api.setAiConsent(agentId, { allow: false, provider: AGENT_PROVIDER });
}

export function ConsentSettings() {
  const { api, connection } = useSignedIn();
  const agents = useQuery({ queryKey: [connection.origin, "agents"], queryFn: api.agents });
  const change = useMutation({ mutationFn: ({ agentId, on }: { agentId: string; on: boolean }) => changeConsent(api, agentId, on), retry: false });
  useSyncExternalStore(subscribeConsent, consentVersion);
  if (!agents.data || agents.data.agents.length === 0) return null;
  return <View style={styles.section}>
    <Text style={styles.title}>AI provider</Text>
    <View style={styles.card}>
      {agents.data.agents.map((agent) => {
        const on = hasConsent(connection.origin, agent.id);
        return <View key={agent.id} style={styles.row}>
          <View style={styles.text}><Text style={styles.name}>{agent.name}</Text><Text style={styles.meta}>{PROVIDER.name}</Text></View>
          <Switch accessibilityLabel={`Send to ${PROVIDER.name} for ${agent.name}`} value={on} disabled={change.isPending}
            onValueChange={(value) => change.mutate({ agentId: agent.id, on: value })} />
        </View>;
      })}
    </View>
    <ErrorLine error={change.error} />
    <Text style={styles.help}>Off: no app sends anything to {PROVIDER.company} for that agent, and its queued and running tasks stop.</Text>
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
