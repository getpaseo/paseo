import { Redirect, useLocalSearchParams } from "expo-router";
import { buildLegacyPluginSurfaceRedirectRoute } from "@/plugins";

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default function LegacyPluginSurfaceRoute() {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    pluginId?: string | string[];
    surfaceId?: string | string[];
  }>();
  return (
    <Redirect
      href={buildLegacyPluginSurfaceRedirectRoute(
        routeParam(params.serverId),
        routeParam(params.pluginId),
        routeParam(params.surfaceId),
      )}
    />
  );
}
