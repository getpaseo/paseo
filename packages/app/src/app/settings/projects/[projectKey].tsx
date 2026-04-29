import { useLocalSearchParams } from "expo-router";
import SettingsScreen from "@/screens/settings-screen";

export default function SettingsProjectDetailRoute() {
  const params = useLocalSearchParams<{ projectKey?: string | string[] }>();
  const rawProjectKey = Array.isArray(params.projectKey) ? params.projectKey[0] : params.projectKey;
  const projectKey = typeof rawProjectKey === "string" ? decodeURIComponent(rawProjectKey) : "";

  // Render through the same SettingsScreen the index uses so the sidebar +
  // header shell stays identical between list and detail. SettingsScreen reads
  // `view.projectKey` to swap the projects section content for the detail.
  return <SettingsScreen view={{ kind: "project", projectKey }} />;
}
