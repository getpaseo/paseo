import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  checkDesktopAppUpdate,
  formatVersionWithPrefix,
  installDesktopAppUpdate,
  shouldShowDesktopUpdateSection,
  subscribeDesktopAppUpdateDownloadProgress,
  type DesktopAppUpdateCheckResult,
  type DesktopAppUpdateCheckIntent,
  type DesktopAppUpdateDownloadProgress,
  type DesktopAppUpdateInstallResult,
} from "@/desktop/updates/desktop-updates";
import { useDesktopSettings, type DesktopUpdateMode } from "@/desktop/settings/desktop-settings";
import { useDesktopIpcErrorReporter } from "@/desktop/hooks/desktop-ipc-error";
import {
  PENDING_RECHECK_MS,
  createDesktopAppUpdater,
  formatStatusText,
  type DesktopAppUpdater,
  type DesktopAppUpdaterErrorReport,
  type DesktopAppUpdateStatus,
} from "@/desktop/updates/desktop-app-updater";
import { formatMessageTimestamp } from "@/utils/time";

export type { DesktopAppUpdateStatus };

let activeInstallErrorReporter: ((report: DesktopAppUpdaterErrorReport) => void) | null = null;
let sharedDesktopAppUpdater: DesktopAppUpdater | null = null;
let progressSubscriptionCount = 0;
let progressUnsubscribe: (() => void) | null = null;

function getSharedDesktopAppUpdater(): DesktopAppUpdater {
  if (!sharedDesktopAppUpdater) {
    sharedDesktopAppUpdater = createDesktopAppUpdater({
      port: {
        checkDesktopAppUpdate,
        installDesktopAppUpdate,
      },
      now: () => Date.now(),
      reportInstallError: (report) => {
        activeInstallErrorReporter?.(report);
      },
    });
  }
  return sharedDesktopAppUpdater;
}

function retainDownloadProgressSubscription(updater: DesktopAppUpdater): () => void {
  progressSubscriptionCount += 1;
  if (progressSubscriptionCount === 1) {
    let active = true;
    const teardown = () => {
      active = false;
    };
    progressUnsubscribe = teardown;
    void subscribeDesktopAppUpdateDownloadProgress((progress) => {
      if (active) {
        updater.setDownloadProgress(progress);
      }
    })
      .then((cleanup) => {
        if (active) {
          progressUnsubscribe = () => {
            active = false;
            cleanup();
          };
        } else {
          cleanup();
        }
        return undefined;
      })
      .catch(() => undefined);
  }

  return () => {
    progressSubscriptionCount = Math.max(0, progressSubscriptionCount - 1);
    if (progressSubscriptionCount === 0) {
      progressUnsubscribe?.();
      progressUnsubscribe = null;
    }
  };
}

export interface UseDesktopAppUpdaterReturn {
  isDesktopApp: boolean;
  updateMode: DesktopUpdateMode;
  isLoadingSettings: boolean;
  status: DesktopAppUpdateStatus;
  statusText: string;
  availableUpdate: DesktopAppUpdateCheckResult | null;
  downloadProgress: DesktopAppUpdateDownloadProgress | null;
  errorMessage: string | null;
  lastCheckedAt: number | null;
  isChecking: boolean;
  isInstalling: boolean;
  checkForUpdates: (options?: {
    intent?: DesktopAppUpdateCheckIntent;
    silent?: boolean;
  }) => Promise<DesktopAppUpdateCheckResult | null>;
  installUpdate: () => Promise<DesktopAppUpdateInstallResult | null>;
}

export function useDesktopAppUpdater(): UseDesktopAppUpdaterReturn {
  const isDesktopApp = shouldShowDesktopUpdateSection();
  const { settings: desktopSettings, isLoading: isLoadingSettings } = useDesktopSettings();
  const releaseChannel = desktopSettings.releaseChannel;
  const updateMode = desktopSettings.updates.mode;
  const reportError = useDesktopIpcErrorReporter();
  const updater = getSharedDesktopAppUpdater();

  useEffect(() => {
    activeInstallErrorReporter = reportError;
  }, [reportError]);

  const snapshot = useSyncExternalStore(
    updater.subscribe,
    updater.getSnapshot,
    updater.getSnapshot,
  );

  const checkForUpdates = useCallback(
    async (options: { intent?: DesktopAppUpdateCheckIntent; silent?: boolean } = {}) => {
      if (!isDesktopApp) {
        return null;
      }
      return updater.checkForUpdates({
        releaseChannel,
        intent: options.intent ?? "manual",
        silent: options.silent,
      });
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
      return undefined;
    }
    return retainDownloadProgressSubscription(updater);
  }, [isDesktopApp, updater]);

  useEffect(() => {
    if (!isDesktopApp || isLoadingSettings || updateMode === "off") {
      return;
    }
    void checkForUpdates({ intent: "automatic", silent: true });
  }, [checkForUpdates, isDesktopApp, isLoadingSettings, updateMode]);

  useEffect(() => {
    if (!isDesktopApp || snapshot.status !== "pending" || updateMode === "off") {
      return undefined;
    }

    const intervalId = setInterval(() => {
      void checkForUpdates({ intent: "automatic", silent: true });
    }, PENDING_RECHECK_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [checkForUpdates, isDesktopApp, snapshot.status, updateMode]);

  return {
    isDesktopApp,
    updateMode,
    isLoadingSettings,
    status: snapshot.status,
    statusText: formatStatusText({
      status: snapshot.status,
      availableUpdate: snapshot.availableUpdate,
      downloadProgress: snapshot.downloadProgress,
      installMessage: snapshot.installMessage,
      lastCheckedAt: snapshot.lastCheckedAt,
      formatVersion: formatVersionWithPrefix,
      formatLastCheckedAt: (timestamp) => formatMessageTimestamp(new Date(timestamp)),
    }),
    availableUpdate: snapshot.availableUpdate,
    downloadProgress: snapshot.downloadProgress,
    errorMessage: snapshot.errorMessage,
    lastCheckedAt: snapshot.lastCheckedAt,
    isChecking: snapshot.isChecking,
    isInstalling: snapshot.isInstalling,
    checkForUpdates,
    installUpdate,
  };
}
