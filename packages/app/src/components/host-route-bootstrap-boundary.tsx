import type { ReactNode } from "react";
import { useHostRuntimeBootstrapState } from "@/app/_layout";
import { useHostRegistryStatus } from "@/runtime/host-runtime";
import { useAppSettings } from "@/hooks/use-settings";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";

export function HostRouteBootstrapBoundary({ children }: { children: ReactNode }) {
  const bootstrapState = useHostRuntimeBootstrapState();
  const hostRegistryStatus = useHostRegistryStatus();
  // Deep links can open a workspace and create its first layout before settings finish
  // loading; that layout would then bake in stale defaults (e.g. alwaysOpenExplorerSidebar).
  const { isLoading: settingsLoading } = useAppSettings();

  if (
    bootstrapState.startupBlocker.kind !== "none" ||
    hostRegistryStatus === "loading" ||
    settingsLoading
  ) {
    return <StartupSplashScreen bootstrapState={bootstrapState} />;
  }

  return children;
}
