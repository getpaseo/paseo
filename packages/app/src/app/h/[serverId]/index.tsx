import { Redirect, useLocalSearchParams } from "expo-router";
import { buildHostOpenProjectRoute } from "@/utils/host-routes";

export default function HostIndexRoute() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  if (!serverId) return null;
  return <Redirect href={buildHostOpenProjectRoute(serverId)} />;
}
