import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { SchedulesScreen } from "@/screens/schedules-screen";

export default function SchedulesRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    agentId?: string;
    intentId?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : undefined;
  const agentId = typeof params.agentId === "string" ? params.agentId : undefined;
  const intentId = typeof params.intentId === "string" ? params.intentId : undefined;
  const screenKey = JSON.stringify([serverId ?? null, agentId ?? null, intentId ?? null]);

  return (
    <HostRouteBootstrapBoundary>
      <SchedulesScreen key={screenKey} createServerId={serverId} createAgentId={agentId} />
    </HostRouteBootstrapBoundary>
  );
}
