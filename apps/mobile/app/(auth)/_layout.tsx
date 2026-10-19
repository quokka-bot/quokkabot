import { Stack } from "expo-router";
import { colors } from "../../src/ui/theme";

// Signing in: the welcome screen first, then a server, a link or a code.
export const unstable_settings = { initialRouteName: "welcome" };

export default function SignInLayout() {
  return <Stack screenOptions={{ headerTintColor: colors.text, headerShadowVisible: false, headerStyle: { backgroundColor: colors.background }, contentStyle: { backgroundColor: colors.background } }}>
    <Stack.Screen name="welcome" options={{ headerShown: false, title: "Quokka Bot" }} />
    <Stack.Screen name="server" options={{ title: "Your server" }} />
    <Stack.Screen name="scan" options={{ title: "Scan the QR code", presentation: "modal" }} />
    <Stack.Screen name="link" options={{ title: "Approve this phone" }} />
    <Stack.Screen name="code" options={{ title: "Sign in with a code" }} />
  </Stack>;
}
