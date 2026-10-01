import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TeamsScreen } from "@/screens/teams-screen";

export default function TeamsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <TeamsScreen />
    </HostRouteBootstrapBoundary>
  );
}
