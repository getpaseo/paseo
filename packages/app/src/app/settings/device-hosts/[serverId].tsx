import { Redirect, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import SettingsScreen from "@/screens/settings-screen";
import { buildSettingsSectionRoute } from "@/utils/host-routes";

export default function SettingsDeviceHostDetailRoute() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId.trim() : "";
  const view = useMemo(() => ({ kind: "clientHost" as const, serverId }), [serverId]);

  if (!serverId) {
    return <Redirect href={buildSettingsSectionRoute("hosts")} />;
  }

  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
