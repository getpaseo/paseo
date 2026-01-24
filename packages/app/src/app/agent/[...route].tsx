import { useLocalSearchParams } from "expo-router";
import { AgentReadyScreen } from "@/screens/agent/agent-ready-screen";
import { LegacyAgentIdScreen } from "@/screens/agent/legacy-agent-id-screen";

type AgentRouteParams = {
  route?: string[] | string;
};

function normalizeSegments(raw: AgentRouteParams["route"]): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === "string" && s.length > 0);
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  return [];
}

export default function AgentCatchAllRoute() {
  const params = useLocalSearchParams<AgentRouteParams>();
  const segments = normalizeSegments(params.route);

  if (segments.length === 1) {
    return <LegacyAgentIdScreen agentId={segments[0]} />;
  }

  if (segments.length >= 2) {
    const [serverId, agentId] = segments;
    return <AgentReadyScreen serverId={serverId} agentId={agentId} />;
  }

  return <LegacyAgentIdScreen agentId="" />;
}

