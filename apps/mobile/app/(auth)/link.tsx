import { useEffect, useRef, useState } from "react";
import { Redirect, router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import Constants from "expo-constants";
import { StyleSheet, Text, View } from "react-native";
import { useSession, appFetch } from "../../src/session";
import { waitForLink } from "../../src/sign-in";
import { chosenLink, forgetChosenServer } from "../../src/sign-in-flow";
import { Button, ErrorLine } from "../../src/ui/kit";
import { colors } from "../../src/ui/theme";

// The phone's sign-in link: the owner approves this code with their passkey, on this phone (the server's own page in
// a browser sheet) or on a computer where they are signed in (Settings, Connect a phone). The phone polls; the
// session comes back to the phone only. The link is the one the server screen started for the server picked there.
export default function Link() {
  const [flow] = useState(chosenLink);
  const { signIn } = useSession();
  const [outcome, setOutcome] = useState<"waiting" | "refused" | "expired">("waiting");
  const [error, setError] = useState<unknown>(null);
  const stopped = useRef(false);
  useEffect(() => {
    if (!flow) return;
    stopped.current = false;
    void waitForLink(appFetch, flow.server.origin, flow.link.pollToken, () => stopped.current).then(async (result) => {
      if ("token" in result) {
        WebBrowser.dismissAuthSession();
        forgetChosenServer();
        await signIn({ ...flow.server, token: result.token });
        return;
      }
      if (result.state !== "stopped") { WebBrowser.dismissAuthSession(); setOutcome(result.state); }
    }).catch(setError);
    return () => { stopped.current = true; };
  }, [flow, signIn]);
  // Opened without a link started here (a link from outside the app, or after a restart): pick the server first.
  if (!flow) return <Redirect href="/server" />;
  const host = new URL(flow.server.origin).host;
  // The sheet closes itself once the poll sees the approval; the scheme is only there to let the page close it too.
  const approveHere = () => void WebBrowser.openAuthSessionAsync(flow.link.verifyUrl, `${String(Constants.expoConfig?.scheme ?? "quokkabot")}://linked`).catch(setError);
  if (outcome !== "waiting") return <View style={styles.page}>
    <Text style={styles.title}>{outcome === "refused" ? "The code was refused." : "The code expired."}</Text>
    <Button title="Start again" onPress={() => router.back()} />
  </View>;
  return <View style={styles.page}>
    <Text style={styles.lead}>Approve this code with your passkey on {host}.</Text>
    <Text style={styles.code} accessibilityLabel={`Code ${flow.link.userCode.split("").join(" ")}`} selectable>{flow.link.userCode}</Text>
    <Button title="Approve on this phone" onPress={approveHere} />
    <Text style={styles.help}>Or, on a computer where you are signed in: Settings, Connect a phone, and type the code.</Text>
    <Text style={styles.waiting}>Waiting for the approval…</Text>
    <ErrorLine error={error} />
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 24, gap: 16, backgroundColor: colors.background },
  title: { fontSize: 20, fontWeight: "600", color: colors.text, textAlign: "center", marginTop: 40 },
  lead: { fontSize: 17, color: colors.text, textAlign: "center", marginTop: 12 },
  code: { fontSize: 34, fontWeight: "700", letterSpacing: 4, textAlign: "center", paddingVertical: 18, borderRadius: 16, backgroundColor: colors.sidebar, color: colors.text, fontVariant: ["tabular-nums"] },
  help: { fontSize: 15, color: colors.textSoft, textAlign: "center", lineHeight: 21 },
  waiting: { fontSize: 14, color: colors.muted, textAlign: "center" },
});
