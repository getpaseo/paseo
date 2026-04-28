import { useLocalSearchParams } from "expo-router";
import ProjectSettingsScreen from "@/screens/project-settings-screen";

export default function SettingsProjectDetailRoute() {
  const params = useLocalSearchParams<{ projectKey?: string | string[] }>();
  const rawProjectKey = Array.isArray(params.projectKey) ? params.projectKey[0] : params.projectKey;
  const projectKey = typeof rawProjectKey === "string" ? decodeURIComponent(rawProjectKey) : "";

  return <ProjectSettingsScreen projectKey={projectKey} />;
}
