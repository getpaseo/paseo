import type { ReactNode } from "react";
import { useHostRuntimeBootstrapState } from "@/app/_layout";
import { useHostRegistryStatus } from "@/runtime/host-runtime";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";

export function HostRouteBootstrapBoundary({ children }: { children: ReactNode }) {
  const bootstrapState = useHostRuntimeBootstrapState();
  const hostRegistryStatus = useHostRegistryStatus();

  if (bootstrapState.startupBlocker.kind !== "none" || hostRegistryStatus === "loading") {
    return <StartupSplashScreen bootstrapState={bootstrapState} />;
  }

  return children;
}
