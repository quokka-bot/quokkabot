import { Redirect } from "expo-router";
import { useSession } from "../src/session";

// The app opens on the agents when this phone is signed in, else on the welcome screen.
export default function Start() {
  const { session } = useSession();
  return <Redirect href={session.state === "signed-in" ? "/agents" : "/welcome"} />;
}
