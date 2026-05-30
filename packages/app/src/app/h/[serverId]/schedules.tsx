import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { SchedulesScreen } from "@/screens/schedules-screen";

export default function HostSchedulesRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostSchedulesRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostSchedulesRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";

  return <SchedulesScreen serverId={serverId} />;
}
