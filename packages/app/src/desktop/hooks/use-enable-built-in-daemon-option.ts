import { useCallback } from "react";
import { router } from "expo-router";
import { getIsElectron } from "@/constants/platform";
import {
  useIsLocalDaemonServerIdResolved,
  useLocalDaemonServerId,
} from "@/hooks/use-is-local-daemon";
import { useHosts } from "@/runtime/host-runtime";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useDaemonStatus } from "@/desktop/hooks/use-daemon-status";
import { useBuiltInDaemonManagement } from "@/desktop/hooks/use-built-in-daemon-management";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

export function useEnableBuiltInDaemonOption(): { visible: boolean; onPress: () => void } {
  const isElectron = getIsElectron();
  const isLocalServerIdResolved = useIsLocalDaemonServerIdResolved();
  const localServerId = useLocalDaemonServerId();
  const hosts = useHosts();
  const { settings, updateSettings } = useDesktopSettings();
  const { data, setStatus, refetch } = useDaemonStatus();
  const { enable } = useBuiltInDaemonManagement({
    daemonStatus: data?.status ?? null,
    settings: settings.daemon,
    updateSettings: (updates) => updateSettings({ daemon: updates }),
    setStatus,
    refreshStatus: refetch,
  });

  const isLocalhostConfigured =
    localServerId !== null && hosts.some((host) => host.serverId === localServerId);
  const visible = isElectron && isLocalServerIdResolved && !isLocalhostConfigured;

  const onPress = useCallback(() => {
    void (async () => {
      const result = await enable();
      if (result?.kind === "enabled") {
        router.push(buildSettingsHostSectionRoute(result.newStatus.serverId, "host"));
      }
    })();
  }, [enable]);

  return { visible, onPress };
}
