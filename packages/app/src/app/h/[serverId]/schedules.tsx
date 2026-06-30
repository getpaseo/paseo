import { Redirect } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { buildSchedulesRoute } from "@/utils/host-routes";

export default function HostSchedulesRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostSchedulesRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostSchedulesRouteContent() {
  return <Redirect href={buildSchedulesRoute()} />;
}
