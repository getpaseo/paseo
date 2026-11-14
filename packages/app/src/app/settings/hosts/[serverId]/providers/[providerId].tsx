import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import SettingsScreen from "@/screens/settings-screen";
import { normalizeProjectSettingsRouteId } from "@/utils/host-routes";

export default function SettingsHostProviderDetailRoute() {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    providerId?: string | string[];
  }>();
  const serverId = normalizeProjectSettingsRouteId(params.serverId);
  const providerId = normalizeProjectSettingsRouteId(params.providerId);
  const view = useMemo(
    () => ({ kind: "provider" as const, serverId, providerId }),
    [providerId, serverId],
  );

  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
