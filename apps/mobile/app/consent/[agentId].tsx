import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ScrollView, StyleSheet, Text } from "react-native";
import { grantConsent, PROVIDER } from "../../src/consent";
import { useSignedIn } from "../../src/session";
import { Button } from "../../src/ui/kit";
import { colors } from "../../src/ui/theme";

// Asked once per agent before this phone sends it anything. Allow returns to the chat; the owner sends again.
export default function Consent() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const { api, connection } = useSignedIn();
  const agent = useQuery({ queryKey: [connection.origin, "agent", agentId], queryFn: () => api.agent(agentId) });
  const name = agent.data?.name ?? "This agent";
  return <ScrollView style={styles.page} contentContainerStyle={styles.content}>
    <Text style={styles.title}>{name} works with {PROVIDER.name}</Text>
    <Text style={styles.body}>What you send {name} from this phone, the pages its computer opens and the files it works on go to {PROVIDER.company}, so Claude can do the task.</Text>
    <Text style={styles.body}>They go through the Claude account signed in on {name}'s computer, under {PROVIDER.company}'s terms and privacy policy.</Text>
    <Text style={styles.link} accessibilityRole="link" onPress={() => void WebBrowser.openBrowserAsync(PROVIDER.privacyUrl)}>{PROVIDER.company}'s privacy policy</Text>
    <Text style={styles.body}>You can turn this off in Settings, AI provider.</Text>
    <Button title={`Allow for ${name}`} disabled={!agent.data} onPress={() => { grantConsent(connection.origin, agentId); router.back(); }} />
    <Button title="Not now" kind="quiet" onPress={() => router.back()} />
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, gap: 16 },
  title: { fontSize: 22, fontWeight: "700", color: colors.text },
  body: { fontSize: 16, lineHeight: 23, color: colors.textSoft },
  link: { fontSize: 16, color: colors.purple },
});
