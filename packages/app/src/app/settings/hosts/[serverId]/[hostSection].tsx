import { Redirect, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import SettingsScreen from "@/screens/settings-screen";
import {
  buildClientHostSettingsRoute,
  buildSettingsHostSectionRoute,
  isHostSectionSlug,
  normalizeHostSectionSlug,
} from "@/utils/host-routes";

export default function SettingsHostSectionRoute() {
  const params = useLocalSearchParams<{ serverId?: string; hostSection?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId.trim() : "";
  const rawSection = typeof params.hostSection === "string" ? params.hostSection : "";
  const normalized = normalizeHostSectionSlug(rawSection);
  const section = normalized ?? "daemon";
  const view = useMemo(() => ({ kind: "host" as const, serverId, section }), [serverId, section]);

  if (rawSection === "connections" && serverId) {
    return <Redirect href={buildClientHostSettingsRoute(serverId)} />;
  }

  if (normalized && !isHostSectionSlug(rawSection) && serverId) {
    return <Redirect href={buildSettingsHostSectionRoute(serverId, normalized)} />;
  }

  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
