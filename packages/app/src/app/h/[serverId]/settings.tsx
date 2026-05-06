import { Redirect, useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { buildSettingsHostRoute, buildSettingsRoute } from "@/utils/host-routes";

export default function LegacyHostSettingsRoute() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId.trim() : "";
  const href = serverId.length > 0 ? buildSettingsHostRoute(serverId) : buildSettingsRoute();

  return (
    <HostRouteBootstrapBoundary>
      <Redirect href={href} />
    </HostRouteBootstrapBoundary>
  );
}
