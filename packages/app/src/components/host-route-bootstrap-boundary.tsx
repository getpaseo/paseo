import type { ReactNode } from "react";
import { useHostRuntimeBootstrapState, useStoreReady } from "@/app/_layout";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";

export function HostRouteBootstrapBoundary({ children }: { children: ReactNode }) {
  const storeReady = useStoreReady();
  const bootstrapState = useHostRuntimeBootstrapState();
  const isDesktop = shouldUseDesktopDaemon();

  if (!storeReady) {
    return <StartupSplashScreen bootstrapState={isDesktop ? bootstrapState : undefined} />;
  }

  return <>{children}</>;
}
