import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { SessionsScreen } from "@/screens/sessions-screen";

export default function HostAgentsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostAgentsRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostAgentsRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";

  return <SessionsScreen serverId={serverId} />;
}
