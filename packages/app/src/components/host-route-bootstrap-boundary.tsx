import { useEffect, type ReactNode } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { useHostRuntimeBootstrapState, useStoreReady } from "@/app/_layout";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useHosts } from "@/runtime/host-runtime";

export function HostRouteBootstrapBoundary({ children }: { children: ReactNode }) {
  const storeReady = useStoreReady();
  const bootstrapState = useHostRuntimeBootstrapState();
  const params = useLocalSearchParams<{ serverId?: string | string[] }>();
  const hosts = useHosts();

  const rawServerId = Array.isArray(params.serverId) ? params.serverId[0] : params.serverId;
  const serverId = typeof rawServerId === "string" ? rawServerId.trim() : "";
  const isInvalidServerId = !serverId || serverId === "undefined" || serverId === "null";
  const hostRegistered = storeReady && !!serverId && hosts.some((h) => h.serverId === serverId);

  useEffect(() => {
    if (!storeReady) return;
    if (isInvalidServerId || !hostRegistered) {
      router.replace("/");
    }
  }, [storeReady, isInvalidServerId, hostRegistered]);

  if (!storeReady) {
    return <StartupSplashScreen bootstrapState={bootstrapState} />;
  }
  if (isInvalidServerId || !hostRegistered) {
    return null;
  }

  return <>{children}</>;
}
