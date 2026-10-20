import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ScrollView, StyleSheet, Text } from "react-native";
import { AGENT_PROVIDER } from "@quokkabot/shared";
import { PROVIDER, useConsent } from "../../src/consent";
import { useSignedIn } from "../../src/session";
import { Button, ErrorLine } from "../../src/ui/kit";
import { colors } from "../../src/ui/theme";

// Asked before this phone sends an agent anything, until the owner allows it. Allow records the permission on the
// server for every app and returns to the chat; the owner sends again.
export default function Consent() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const { api, connection } = useSignedIn();
  const agent = useQuery({ queryKey: [connection.origin, "agent", agentId], queryFn: () => api.agent(agentId) });
  const allow = useMutation({
    mutationFn: (generation: number) => api.setAiConsent(agentId, { allow: true, provider: AGENT_PROVIDER, disclosureVersion: PROVIDER.disclosureVersion, generation }),
    onSuccess: () => router.back(),
    retry: false,
  });
  // Another app allowed it since this phone last read the agent: nothing to ask.
  const consented = useConsent(agentId);
  useEffect(() => { if (consented && !allow.isPending && !allow.isSuccess) router.back(); }, [consented, allow.isPending, allow.isSuccess]);
  const name = agent.data?.name ?? "This agent";
  // A server older than the phone keeps no permission records, so the phone cannot ask it to.
  const unsupported = agent.data !== undefined && agent.data.aiConsent === null;
  return <ScrollView style={styles.page} contentContainerStyle={styles.content}>
    <Text style={styles.title}>{name} works with {PROVIDER.name}</Text>
    <Text style={styles.body}>What you send {name}, the pages its computer opens and the files it works on go to {PROVIDER.company}, so Claude can do the task.</Text>
    <Text style={styles.body}>They go through the Claude account signed in on {name}'s computer, under {PROVIDER.company}'s terms and privacy policy.</Text>
    <Text style={styles.link} accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(PROVIDER.privacyUrl)}>{PROVIDER.company}'s privacy policy</Text>
    <Text style={styles.body}>Your choice holds in every app you use with this server. You can turn it off in Settings, AI provider.</Text>
    {unsupported && <Text style={styles.body}>Update this server first: it does not keep this permission yet, so this phone cannot send to {name}.</Text>}
    <ErrorLine error={agent.error ?? allow.error} />
    <Button title={`Allow for ${name}`} disabled={!agent.data || unsupported} busy={allow.isPending}
      onPress={() => { if (agent.data) allow.mutate(agent.data.generation); }} />
    <Button title="Not now" kind="quiet" disabled={allow.isPending} onPress={() => router.back()} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, gap: 16 },
  title: { fontSize: 22, fontWeight: "700", color: colors.text },
  body: { fontSize: 16, lineHeight: 23, color: colors.textSoft },
  link: { fontSize: 16, color: colors.purple },
});
