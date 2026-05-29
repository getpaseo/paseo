import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  checkDesktopAppUpdate,
  formatVersionWithPrefix,
  installDesktopAppUpdate,
  shouldShowDesktopUpdateSection,
  type DesktopAppUpdateCheckResult,
  type DesktopAppUpdateInstallResult,
} from "@/desktop/updates/desktop-updates";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useDesktopIpcErrorReporter } from "@/desktop/hooks/desktop-ipc-error";
import {
  PENDING_RECHECK_MS,
  createDesktopAppUpdater,
  formatStatusText,
  type DesktopAppUpdateStatus,
} from "@/desktop/updates/desktop-app-updater";

export type { DesktopAppUpdateStatus };

export interface UseDesktopAppUpdaterReturn {
  isDesktopApp: boolean;
  status: DesktopAppUpdateStatus;
  statusText: string;
  availableUpdate: DesktopAppUpdateCheckResult | null;
  errorMessage: string | null;
  lastCheckedAt: number | null;
  isChecking: boolean;
  isInstalling: boolean;
  checkForUpdates: (options?: { silent?: boolean }) => Promise<DesktopAppUpdateCheckResult | null>;
  installUpdate: () => Promise<DesktopAppUpdateInstallResult | null>;
}

export function useDesktopAppUpdater(): UseDesktopAppUpdaterReturn {
  const isDesktopApp = shouldShowDesktopUpdateSection();
  const { settings: desktopSettings } = useDesktopSettings();
  const releaseChannel = desktopSettings.releaseChannel;
  const reportError = useDesktopIpcErrorReporter();

  const updater = useMemo(
    () =>
      createDesktopAppUpdater({
        port: {
          checkDesktopAppUpdate,
          installDesktopAppUpdate,
        },
        now: () => Date.now(),
        reportInstallError: reportError,
      }),
    [reportError],
  );

  const snapshot = useSyncExternalStore(
    updater.subscribe,
    updater.getSnapshot,
    updater.getSnapshot,
  );

  const checkForUpdates = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!isDesktopApp) {
        return null;
      }
      return updater.checkForUpdates({ releaseChannel, silent: options.silent });
    },
    [isDesktopApp, releaseChannel, updater],
  );

  const installUpdate = useCallback(async () => {
    if (!isDesktopApp) {
      return null;
    }
    return updater.installUpdate({ releaseChannel });
  }, [isDesktopApp, releaseChannel, updater]);

  useEffect(() => {
    if (!isDesktopApp) {
      return;
    }
    void checkForUpdates({ silent: true });
  }, [checkForUpdates, isDesktopApp]);

  useEffect(() => {
    if (!isDesktopApp || snapshot.status !== "pending") {
      return undefined;
    }

    const intervalId = setInterval(() => {
      void checkForUpdates({ silent: true });
    }, PENDING_RECHECK_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [checkForUpdates, isDesktopApp, snapshot.status]);

  return {
    isDesktopApp,
    status: snapshot.status,
    statusText: formatStatusText({
      status: snapshot.status,
      availableUpdate: snapshot.availableUpdate,
      installMessage: snapshot.installMessage,
      formatVersion: formatVersionWithPrefix,
    }),
    availableUpdate: snapshot.availableUpdate,
    errorMessage: snapshot.errorMessage,
    lastCheckedAt: snapshot.lastCheckedAt,
    isChecking: snapshot.isChecking,
    isInstalling: snapshot.isInstalling,
    checkForUpdates,
    installUpdate,
  };
}
