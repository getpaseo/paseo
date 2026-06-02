import { Redirect, useLocalSearchParams } from "expo-router";
import { buildSettingsHostSectionRoute, buildSettingsRoute } from "@/utils/host-routes";

export default function SettingsHostIndexRoute() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId.trim() : "";

  if (!serverId) {
    return <Redirect href={buildSettingsRoute()} />;
  }

  return <Redirect href={buildSettingsHostSectionRoute(serverId, "connections")} />;
}
