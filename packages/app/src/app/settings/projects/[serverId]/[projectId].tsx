import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import SettingsScreen from "@/screens/settings-screen";
import { normalizeProjectSettingsRouteId } from "@/utils/host-routes";

export default function SettingsProjectDetailRoute() {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    projectId?: string | string[];
  }>();
  const serverId = normalizeProjectSettingsRouteId(params.serverId);
  const projectId = normalizeProjectSettingsRouteId(params.projectId);
  const view = useMemo(
    () => ({ kind: "project" as const, serverId, projectId }),
    [projectId, serverId],
  );

  return <SettingsScreen view={view} />;
}
