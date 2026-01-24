import { useLocalSearchParams } from "expo-router";
import { LegacyAgentIdScreen } from "@/screens/agent/legacy-agent-id-screen";

export default function LegacyAgentRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <LegacyAgentIdScreen agentId={typeof id === "string" ? id : ""} />;
}

