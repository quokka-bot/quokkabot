import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { useSignedIn } from "../session";

// The agent's computer as Selkies streams it, on the server's own viewer origin. The page is the server's viewer
// client: it gets a one-time ticket, nothing else from the app, and no bridge to it (no onMessage). It cannot leave
// the viewer origin, open windows, use the camera or microphone, or keep cookies after the screen closes.
export function Viewer({ agentId, revision }: { agentId: string; revision: number }) {
  const { api, connection } = useSignedIn();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null); setError(null);
    // A ticket works once and for a minute: never cached, fetched for each viewer.
    void api.viewTicket(agentId, connection.viewOrigin).then((next) => { if (alive) setUrl(next); },
      (failure: unknown) => { if (alive) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => { alive = false; };
  }, [agentId, api, connection.viewOrigin, revision]);
  if (error) return <View style={styles.center}><Text style={styles.text}>{error}</Text></View>;
  if (!url) return <View style={styles.center}><ActivityIndicator color="#fff" /></View>;
  return <WebView
    source={{ uri: url }}
    style={styles.web}
    incognito
    originWhitelist={[connection.viewOrigin]}
    onShouldStartLoadWithRequest={(request) => request.url === "about:blank" || new URL(request.url).origin === connection.viewOrigin}
    javaScriptCanOpenWindowsAutomatically={false}
    setSupportMultipleWindows={false}
    mediaCapturePermissionGrantType="deny"
    allowsInlineMediaPlayback
    mediaPlaybackRequiresUserAction={false}
    allowsBackForwardNavigationGestures={false}
    allowsLinkPreview={false}
    dataDetectorTypes="none"
    scrollEnabled={false}
    bounces={false}
    contentInsetAdjustmentBehavior="never"
    automaticallyAdjustContentInsets={false}
    keyboardDisplayRequiresUserAction={false}
    onError={(event) => setError(`The live view did not load: ${event.nativeEvent.description}`)}
    onHttpError={(event) => setError(event.nativeEvent.statusCode === 403 ? "The live view link expired. Close and open the computer again." : `The live view answered HTTP ${event.nativeEvent.statusCode}.`)}
    accessibilityLabel="The agent's computer"
  />;
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "#000" },
  text: { color: "#fff", fontSize: 16, textAlign: "center" },
});
