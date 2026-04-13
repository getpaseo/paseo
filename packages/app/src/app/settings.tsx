import { useEffect, useMemo } from "react";
import { useRouter } from "expo-router";
import { useHostRuntimeBootstrapState } from "@/app/_layout";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useHosts } from "@/runtime/host-runtime";
import { resolveLegacySettingsTargetRoute } from "@/utils/settings-routing";

export default function LegacySettingsRoute() {
  const router = useRouter();
  const daemons = useHosts();
  const bootstrapState = useHostRuntimeBootstrapState();

  const targetRoute = useMemo(() => {
    return resolveLegacySettingsTargetRoute(daemons[0]?.serverId);
  }, [daemons]);

  useEffect(() => {
    router.replace(targetRoute);
  }, [router, targetRoute]);

  return <StartupSplashScreen bootstrapState={bootstrapState} />;
}
