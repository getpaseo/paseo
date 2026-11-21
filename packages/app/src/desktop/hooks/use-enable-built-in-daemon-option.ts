import { useCallback } from "react";
import { router } from "expo-router";
import { getIsElectron } from "@/constants/platform";
import { useHosts } from "@/runtime/host-runtime";
import { useDaemonStatus } from "@/desktop/hooks/use-daemon-status";
import { useManualDaemonLifecycle } from "@/desktop/hooks/use-manual-daemon-lifecycle";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";

export interface EnableBuiltInDaemonOption {
  visible: boolean;
  onPress: () => void;
}

// Shows when the built-in daemon's host is unknown (e.g. it has never started
// in this install). Starting it registers the localhost host connection, which
// makes the daemon appear in the host list without enabling launch autostart.
export function useEnableBuiltInDaemonOption(): EnableBuiltInDaemonOption {
  const isElectron = getIsElectron();
  const localDaemon = useLocalDaemonServerIdState();
  const hosts = useHosts();
  const { setStatus, refetch } = useDaemonStatus();
  const { start } = useManualDaemonLifecycle({
    setStatus,
    refreshStatus: refetch,
  });

  const isLocalhostConfigured =
    localDaemon.status === "resolved" &&
    localDaemon.serverId !== null &&
    hosts.some((host) => host.serverId === localDaemon.serverId);
  const visible = isElectron && localDaemon.status === "resolved" && !isLocalhostConfigured;

  const onPress = useCallback(() => {
    void (async () => {
      const result = await start();
      if (result) {
        router.push(buildSettingsHostSectionRoute(result.serverId, "host"));
      }
    })();
  }, [start]);

  return { visible, onPress };
}
