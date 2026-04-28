import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import SettingsScreen from "@/screens/settings-screen";

export default function SettingsProjectDetailRoute() {
  const params = useLocalSearchParams<{ projectKey?: string | string[] }>();
  const rawProjectKey = Array.isArray(params.projectKey) ? params.projectKey[0] : params.projectKey;
  const projectKey = typeof rawProjectKey === "string" ? decodeURIComponent(rawProjectKey) : "";
  const view = useMemo(() => ({ kind: "project" as const, projectKey }), [projectKey]);

  return <SettingsScreen view={view} />;
}
