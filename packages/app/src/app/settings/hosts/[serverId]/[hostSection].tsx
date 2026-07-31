import { Redirect, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { useHostRuntimeBootstrapState } from "@/app/_layout";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import SettingsScreen from "@/screens/settings-screen";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { buildSettingsHostSectionRoute, normalizeHostSectionSlug } from "@/utils/host-routes";

function PairDeviceSettingsRoute({ serverId }: { serverId: string }) {
  const localDaemon = useLocalDaemonServerIdState();
  const bootstrapState = useHostRuntimeBootstrapState();
  const view = useMemo(
    () => ({ kind: "host" as const, serverId, section: "pair-device" as const }),
    [serverId],
  );

  if (localDaemon.status === "loading") {
    return <StartupSplashScreen bootstrapState={bootstrapState} />;
  }

  if (localDaemon.status !== "resolved" || localDaemon.serverId !== serverId) {
    return <Redirect href={buildSettingsHostSectionRoute(serverId, "connections")} />;
  }

  return <SettingsScreen view={view} />;
}

export default function SettingsHostSectionRoute() {
  const params = useLocalSearchParams<{ serverId?: string; hostSection?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId.trim() : "";
  const rawSection = typeof params.hostSection === "string" ? params.hostSection : "";
  const section = normalizeHostSectionSlug(rawSection) ?? "connections";
  const view = useMemo(() => ({ kind: "host" as const, serverId, section }), [serverId, section]);

  return (
    <HostRouteBootstrapBoundary>
      {section === "pair-device" ? (
        <PairDeviceSettingsRoute serverId={serverId} />
      ) : (
        <SettingsScreen view={view} />
      )}
    </HostRouteBootstrapBoundary>
  );
}
