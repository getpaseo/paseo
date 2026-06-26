import { Redirect, useLocalSearchParams } from "expo-router";
import { buildOpenProjectRoute } from "@/utils/host-routes";

export default function HostIndexRoute() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  if (!serverId) return null;
  // COMPAT(hostRootOpenProjectRoute): added 2026-06-11, remove after 2026-12-11.
  return <Redirect href={buildOpenProjectRoute()} />;
}
