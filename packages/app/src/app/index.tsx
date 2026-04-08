import { useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "expo-router";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import {
  useHostRuntimeBootstrapState,
  useStoreReady,
} from "@/app/_layout";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { buildHostRootRoute } from "@/utils/host-routes";

const WELCOME_ROUTE = "/welcome";

function useAnyOnlineHostServerId(serverIds: string[]): string | null {
  const runtime = getHostRuntimeStore();

  return useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
    () => null,
  );
}

export default function Index() {
  const router = useRouter();
  const pathname = usePathname();
  const bootstrapState = useHostRuntimeBootstrapState();
  const storeReady = useStoreReady();
  const hosts = useHosts();
  const anyOnlineServerId = useAnyOnlineHostServerId(hosts.map((host) => host.serverId));

  useEffect(() => {
    if (!storeReady) {
      return;
    }
    if (pathname !== "/" && pathname !== "") {
      return;
    }

    const targetRoute = anyOnlineServerId
      ? buildHostRootRoute(anyOnlineServerId)
      : WELCOME_ROUTE;
    router.replace(targetRoute);
  }, [anyOnlineServerId, pathname, router, storeReady]);

  return <StartupSplashScreen bootstrapState={bootstrapState} />;
}
