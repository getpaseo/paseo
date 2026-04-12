import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import SettingsScreen from "@/screens/settings-screen";

export default function HostSettingsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen />
    </HostRouteBootstrapBoundary>
  );
}
