import { RefreshCw } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import { SidebarCalloutDescriptionText } from "@/components/sidebar-callout";
import { isWeb } from "@/constants/platform";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import {
  getDesktopRuntimeInfo,
  relaunchDesktopApp,
  shouldShowDesktopUpdateSection,
  type DesktopRuntimeInfo,
} from "@/desktop/updates/desktop-updates";
import { resolveDesktopSyncCalloutDescriptor } from "@/desktop/updates/resolve-desktop-sync-callout";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useSessionStore } from "@/stores/session-store";

const RUNTIME_INFO_POLL_MS = 60_000;

const ThemedRefreshIcon = withUnistyles(RefreshCw, (theme) => ({
  size: theme.iconSize.sm,
  color: theme.colors.foregroundMuted,
}));

export function DesktopSyncCalloutSource() {
  const isDesktopApp = shouldShowDesktopUpdateSection();
  const callouts = useSidebarCallouts();
  const localServerId = useLocalDaemonServerId();
  const daemonVersion = useSessionStore((state) =>
    localServerId ? (state.sessions[localServerId]?.serverInfo?.version ?? null) : null,
  );
  const { settings } = useDesktopSettings();
  const [runtimeInfo, setRuntimeInfo] = useState<DesktopRuntimeInfo | null>(null);
  const [isRelaunching, setIsRelaunching] = useState(false);

  const relaunch = useStableEvent(() => {
    setIsRelaunching(true);
    void relaunchDesktopApp().catch((error) => {
      console.warn("[DesktopSyncCallout] Failed to relaunch desktop app", error);
      setIsRelaunching(false);
    });
  });

  useEffect(() => {
    if (!isDesktopApp) {
      return;
    }

    let cancelled = false;

    const refreshRuntimeInfo = () => {
      void getDesktopRuntimeInfo()
        .then((nextRuntimeInfo) => {
          if (!cancelled) {
            setRuntimeInfo(nextRuntimeInfo);
          }
          return nextRuntimeInfo;
        })
        .catch((error) => {
          console.warn("[DesktopSyncCallout] Failed to load desktop runtime info", error);
        });
    };

    refreshRuntimeInfo();

    const intervalId = setInterval(refreshRuntimeInfo, RUNTIME_INFO_POLL_MS);

    const handleVisibilityOrFocus = () => {
      if (isWeb && typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      refreshRuntimeInfo();
    };

    if (isWeb && typeof window !== "undefined") {
      window.addEventListener("focus", handleVisibilityOrFocus);
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", handleVisibilityOrFocus);
      }
    }

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      if (isWeb && typeof window !== "undefined") {
        window.removeEventListener("focus", handleVisibilityOrFocus);
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
        }
      }
    };
  }, [daemonVersion, isDesktopApp]);

  const descriptor = useMemo(
    () =>
      resolveDesktopSyncCalloutDescriptor({
        isDesktopApp,
        appVersion: runtimeInfo?.appVersion ?? null,
        daemonVersion,
        displacedBundle: runtimeInfo?.displacedBundle ?? false,
        onDiskAppVersion: runtimeInfo?.onDiskAppVersion ?? null,
        keepRunningAfterQuit: settings.daemon.keepRunningAfterQuit,
        isRelaunching,
      }),
    [
      daemonVersion,
      isDesktopApp,
      isRelaunching,
      runtimeInfo?.appVersion,
      runtimeInfo?.displacedBundle,
      runtimeInfo?.onDiskAppVersion,
      settings.daemon.keepRunningAfterQuit,
    ],
  );

  useEffect(() => {
    if (!descriptor) {
      return;
    }

    return callouts.show({
      id: descriptor.id,
      dismissalKey: descriptor.dismissalKey,
      priority: descriptor.priority,
      title: descriptor.title,
      description: (
        <>
          {descriptor.descriptionLines.map((line) => (
            <SidebarCalloutDescriptionText key={line}>{line}</SidebarCalloutDescriptionText>
          ))}
        </>
      ),
      icon: <ThemedRefreshIcon />,
      variant: "default",
      actions: [
        {
          label: descriptor.actionLabel,
          onPress: relaunch,
          variant: "primary",
          disabled: descriptor.actionDisabled,
        },
      ],
      testID: descriptor.testID,
    });
  }, [callouts, descriptor, relaunch]);

  return null;
}
