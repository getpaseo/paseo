import { useLocalSearchParams } from "expo-router";
import { AgentReadyScreen } from "@/screens/agent/agent-ready-screen";

export default function AgentReadyRoute() {
  const { serverId, agentId } = useLocalSearchParams<{
    serverId?: string;
    agentId?: string;
  }>();

  return (
    <AgentReadyScreen
      serverId={typeof serverId === "string" ? serverId : ""}
      agentId={typeof agentId === "string" ? agentId : ""}
    />
  );
}

