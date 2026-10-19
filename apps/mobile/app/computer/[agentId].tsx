import { useLocalSearchParams } from "expo-router";
import { ComputerScreen } from "../../src/computer/computer-screen";

export default function Computer() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  return <ComputerScreen agentId={agentId} />;
}
