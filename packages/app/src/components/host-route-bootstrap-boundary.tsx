import type { ReactNode } from "react";
import { useHostRuntimeBootstrapState, useStoreReady } from "@/app/_layout";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";

export function HostRouteBootstrapBoundary({ children }: { children: ReactNode }) {
  const storeReady = useStoreReady();
  const bootstrapState = useHostRuntimeBootstrapState();

  if (!storeReady) {
    return <StartupSplashScreen bootstrapState={bootstrapState} />;
  }

  return <>{children}</>;
}
