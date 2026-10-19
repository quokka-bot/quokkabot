import { useState } from "react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "../src/session";
import { colors } from "../src/ui/theme";

// Server data refreshes when the app comes back to the front, as the web app does when its tab does.
AppState.addEventListener("change", (state) => focusManager.setFocused(state === "active"));

export default function RootLayout() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }));
  return <SafeAreaProvider>
    <QueryClientProvider client={client}>
      <SessionProvider>
        <StatusBar style="dark" />
        <Screens />
      </SessionProvider>
    </QueryClientProvider>
  </SafeAreaProvider>;
}

function Screens() {
  const { session } = useSession();
  if (session.state === "loading") return <View style={styles.center}><ActivityIndicator /></View>;
  if (session.state === "failed") return <View style={styles.center}><Text style={styles.error}>{session.error.message}</Text></View>;
  const signedIn = session.state === "signed-in";
  return <Stack screenOptions={{ headerTintColor: colors.text, headerShadowVisible: false, headerStyle: { backgroundColor: colors.background }, contentStyle: { backgroundColor: colors.background } }}>
    <Stack.Protected guard={!signedIn}>
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
      <Stack.Screen name="server" options={{ title: "Your server" }} />
      <Stack.Screen name="scan" options={{ title: "Scan the QR code", presentation: "modal" }} />
      <Stack.Screen name="link" options={{ title: "Approve this phone" }} />
      <Stack.Screen name="code" options={{ title: "Sign in with a code" }} />
    </Stack.Protected>
    <Stack.Protected guard={signedIn}>
      <Stack.Screen name="index" options={{ title: "Agents", headerLargeTitle: true }} />
      <Stack.Screen name="agents/[agentId]" options={{ title: "" }} />
      <Stack.Screen name="computer/[agentId]" options={{ headerShown: false, presentation: "fullScreenModal" }} />
      <Stack.Screen name="settings" options={{ title: "Settings" }} />
      <Stack.Screen name="consent/[agentId]" options={{ title: "Before you start", presentation: "modal" }} />
    </Stack.Protected>
    <Stack.Screen name="connect" options={{ headerShown: false }} />
  </Stack>;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: colors.background },
  error: { color: colors.red, fontSize: 15, textAlign: "center" },
});
