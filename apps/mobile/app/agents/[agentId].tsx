import { useLocalSearchParams } from "expo-router";
import { AgentChat } from "../../src/chat/agent-chat";

export default function AgentScreen() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  return <AgentChat agentId={agentId} />;
}
