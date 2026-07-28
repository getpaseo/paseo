import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import SettingsScreen from "@/screens/settings-screen";
import { normalizeProjectSettingsRouteKey } from "@/utils/host-routes";

export default function SettingsProjectDetailRoute() {
  const params = useLocalSearchParams<{ projectKey?: string | string[] }>();
  const projectKey = normalizeProjectSettingsRouteKey(params.projectKey);
  const view = useMemo(() => ({ kind: "project" as const, projectKey }), [projectKey]);

  return <SettingsScreen view={view} />;
}
