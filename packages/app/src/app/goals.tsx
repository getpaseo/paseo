import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { GoalsScreen } from "@/screens/goals-screen";

export default function GoalsRoute() {
  const params = useLocalSearchParams<{ serverId?: string; goalId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : undefined;
  const goalId = typeof params.goalId === "string" ? params.goalId : undefined;

  return (
    <HostRouteBootstrapBoundary>
      <GoalsScreen
        key={JSON.stringify([serverId ?? null, goalId ?? null])}
        initialServerId={serverId}
        initialGoalId={goalId}
      />
    </HostRouteBootstrapBoundary>
  );
}
