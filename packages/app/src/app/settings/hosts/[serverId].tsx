import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import SettingsScreen from "@/screens/settings-screen";

export default function SettingsHostRoute() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId.trim() : "";

  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen view={{ kind: "host", serverId }} />
    </HostRouteBootstrapBoundary>
  );
}
