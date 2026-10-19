import { Redirect, useLocalSearchParams } from "expo-router";
import { useSession } from "../src/session";

// quokkabot://connect?server=… from the QR code, opened by the Camera app: straight to the server screen.
export default function Connect() {
  const { server } = useLocalSearchParams<{ server?: string }>();
  const { session } = useSession();
  if (session.state === "signed-in") return <Redirect href="/" />;
  return <Redirect href={{ pathname: "/server", params: server ? { server } : {} }} />;
}
