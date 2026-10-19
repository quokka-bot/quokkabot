import { useRef } from "react";
import { router } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { StyleSheet, Text, View } from "react-native";
import { serverOrigin } from "../../src/sign-in";
import { Button } from "../../src/ui/kit";
import { colors } from "../../src/ui/theme";

// Reads the QR code from Settings, Connect a phone. It holds only the server's address; the address is checked and
// approved on the next screens like a typed one.
export default function Scan() {
  const [permission, request] = useCameraPermissions();
  const done = useRef(false);
  if (!permission) return <View style={styles.page} />;
  if (!permission.granted) return <View style={[styles.page, styles.center]}>
    <Text style={styles.text}>The camera reads the QR code your server shows. Nothing is recorded.</Text>
    {permission.canAskAgain ? <Button title="Allow the camera" onPress={() => void request()} /> : <Text style={styles.text}>Allow the camera for Quokka Bot in the Settings app, or type the address.</Text>}
  </View>;
  return <View style={styles.page}>
    <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => {
      if (done.current) return;
      let origin: string;
      try { origin = serverOrigin(data); } catch { return; }
      done.current = true;
      router.dismissTo({ pathname: "/server", params: { server: origin } });
    }} />
    <View style={styles.hint}><Text style={styles.hintText}>Point the camera at the code in Settings, Connect a phone.</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000" },
  center: { alignItems: "center", justifyContent: "center", padding: 24, gap: 16, backgroundColor: colors.background },
  text: { fontSize: 16, color: colors.textSoft, textAlign: "center" },
  hint: { position: "absolute", bottom: 60, left: 24, right: 24, padding: 14, borderRadius: 14, backgroundColor: "rgba(0,0,0,0.6)" },
  hintText: { color: "#fff", fontSize: 15, textAlign: "center" },
});
