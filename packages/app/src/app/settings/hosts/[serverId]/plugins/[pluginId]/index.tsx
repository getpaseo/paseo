import { useMemo } from "react";

import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import SettingsScreen from "@/screens/settings-screen";

/** An installed plugin's page. A settings tab chosen on it arrives as `screenId`. */
export default function PluginPageRoute() {
  const { serverId, pluginId, screenId } = useLocalSearchParams<{
    serverId: string;
    pluginId: string;
    screenId?: string;
  }>();
  const view = useMemo(
    () => ({ kind: "plugin" as const, serverId, pluginId, screenId }),
    [serverId, pluginId, screenId],
  );
  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
