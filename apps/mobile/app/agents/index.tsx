import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import type { AgentSummary } from "@quokkabot/shared";
import { useSignedIn } from "../../src/session";
import { AgentAvatar, ErrorLine, Notice } from "../../src/ui/kit";
import { colors } from "../../src/ui/theme";

// The agents, with how many things each one waits on (questions, logins, sites, takeovers). Pending cards are
// fetched every time the app opens, so nothing depends on a notification arriving.
export default function Agents() {
  const { api, connection } = useSignedIn();
  const agents = useQuery({ queryKey: [connection.origin, "agents"], queryFn: api.agents, refetchInterval: 15_000 });
  const inbox = useQuery({ queryKey: [connection.origin, "inbox"], queryFn: api.inbox, refetchInterval: 15_000 });
  const waiting = (agentId: string) => (inbox.data?.items ?? []).filter((item) => item.agentId === agentId).length;
  return <>
    <Stack.Screen options={{ headerRight: () => <Pressable accessibilityRole="button" onPress={() => router.push("/settings")}><Text style={styles.headerButton}>Settings</Text></Pressable> }} />
    <FlatList contentInsetAdjustmentBehavior="automatic" style={styles.list} data={agents.data?.agents ?? []} keyExtractor={(agent) => agent.id}
      refreshControl={<RefreshControl refreshing={agents.isRefetching} onRefresh={() => { void agents.refetch(); void inbox.refetch(); }} />}
      ListHeaderComponent={<ErrorLine error={agents.error ?? inbox.error} />}
      ListEmptyComponent={agents.isPending ? <Notice>Loading…</Notice> : <Notice>No agents yet. Add one in the web app on {new URL(connection.origin).host}.</Notice>}
      renderItem={({ item }) => <AgentRow agent={item} waiting={waiting(item.id)} />} />
  </>;
}

function AgentRow({ agent, waiting }: { agent: AgentSummary; waiting: number }) {
  const computer = agent.computer.state === "running" ? "Computer on" : "Computer off";
  return <Pressable accessibilityRole="button" accessibilityLabel={`${agent.name}${waiting > 0 ? `, ${waiting} waiting for you` : ""}`}
    style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={() => router.push({ pathname: "/agents/[agentId]", params: { agentId: agent.id } })}>
    <AgentAvatar index={agent.index} size={44} />
    <View style={styles.rowText}>
      <Text style={styles.name}>{agent.name}</Text>
      <Text style={styles.meta}>{agent.cliSignedIn === "yes" ? computer : "Claude is not signed in"}</Text>
    </View>
    {waiting > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{waiting}</Text></View>}
  </Pressable>;
}

const styles = StyleSheet.create({
  list: { backgroundColor: colors.background },
  headerButton: { color: colors.purple, fontSize: 17 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, backgroundColor: colors.background },
  pressed: { backgroundColor: colors.sidebar },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: "600", color: colors.text },
  meta: { fontSize: 14, color: colors.muted },
  badge: { minWidth: 26, height: 26, borderRadius: 13, paddingHorizontal: 8, alignItems: "center", justifyContent: "center", backgroundColor: colors.purple },
  badgeText: { color: "#fff", fontSize: 14, fontWeight: "700" },
});
