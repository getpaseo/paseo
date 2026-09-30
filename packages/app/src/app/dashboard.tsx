import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { DashboardScreen } from "@/leitstand/dashboard-screen";

export default function DashboardRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <DashboardScreen />
    </HostRouteBootstrapBoundary>
  );
}
