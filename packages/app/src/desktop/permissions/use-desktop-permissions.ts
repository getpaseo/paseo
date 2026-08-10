import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getDesktopPermissionSnapshot,
  requestDesktopPermission,
  shouldShowDesktopPermissionSection,
  type DesktopPermissionKind,
  type DesktopPermissionSnapshot,
} from "@/desktop/permissions/desktop-permissions";
import { queryClient } from "@/data/query-client";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  normalizeAppSettings,
} from "@/hooks/use-settings/storage";
import { playAttentionSound } from "@/utils/attention-sound";
import { sendOsNotification } from "@/utils/os-notifications";

export interface UseDesktopPermissionsReturn {
  isDesktopApp: boolean;
  snapshot: DesktopPermissionSnapshot | null;
  isRefreshing: boolean;
  requestingPermission: DesktopPermissionKind | null;
  testNotificationState: TestNotificationState;
  refreshPermissions: () => Promise<void>;
  requestPermission: (kind: DesktopPermissionKind) => Promise<void>;
  sendTestNotification: () => Promise<void>;
}

export type TestNotificationState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "success" }
  | { status: "error"; message: string };

export function useDesktopPermissions(): UseDesktopPermissionsReturn {
  const { t } = useTranslation();
  const isDesktopApp = shouldShowDesktopPermissionSection();
  const isMountedRef = useRef(true);
  const [snapshot, setSnapshot] = useState<DesktopPermissionSnapshot | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [requestingPermission, setRequestingPermission] = useState<DesktopPermissionKind | null>(
    null,
  );
  const [testNotificationState, setTestNotificationState] = useState<TestNotificationState>({
    status: "idle",
  });

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshPermissions = useCallback(async () => {
    if (!isDesktopApp) {
      return;
    }

    setIsRefreshing(true);
    try {
      const nextSnapshot = await getDesktopPermissionSnapshot();
      if (!isMountedRef.current) {
        return;
      }
      setSnapshot(nextSnapshot);
    } catch (error) {
      console.error("[Settings] Failed to load desktop permission status", error);
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [isDesktopApp]);

  const requestPermission = useCallback(
    async (kind: DesktopPermissionKind) => {
      if (!isDesktopApp) {
        return;
      }

      setRequestingPermission(kind);
      try {
        const status = await requestDesktopPermission({ kind });
        if (!isMountedRef.current) {
          return;
        }

        setSnapshot((previous) => {
          const base: DesktopPermissionSnapshot = previous ?? {
            checkedAt: Date.now(),
            notifications: {
              state: "unknown",
              detail: t("desktop.permissions.empty.notifications"),
            },
            microphone: {
              state: "unknown",
              detail: t("desktop.permissions.empty.microphone"),
            },
          };

          if (kind === "notifications") {
            return {
              ...base,
              checkedAt: Date.now(),
              notifications: status,
            };
          }

          return {
            ...base,
            checkedAt: Date.now(),
            microphone: status,
          };
        });
      } catch (error) {
        console.error(`[Settings] Failed to request ${kind} permission`, error);
      } finally {
        if (isMountedRef.current) {
          setRequestingPermission(null);
        }
        await refreshPermissions();
      }
    },
    [isDesktopApp, refreshPermissions, t],
  );

  const sendTestNotification = useCallback(async () => {
    if (!isDesktopApp) {
      return;
    }

    setTestNotificationState({ status: "sending" });
    try {
      const settings = normalizeAppSettings(
        queryClient.getQueryData(APP_SETTINGS_QUERY_KEY) ?? DEFAULT_CLIENT_SETTINGS,
      );
      // Always preview the curated in-app chime for the selected preset so Test
      // matches what banners/intrusive use. OS bubble sound is system-owned and
      // is not preset-selectable.
      if (settings.attentionSoundEnabled) {
        playAttentionSound(settings.attentionSoundPreset);
      }

      if (!settings.attentionOsBubbleEnabled) {
        // Sound-only test when bubble is off still counts as success if we played.
        if (!isMountedRef.current) {
          return;
        }
        setTestNotificationState(
          settings.attentionSoundEnabled
            ? { status: "success" }
            : {
                status: "error",
                message: t("desktop.permissions.testNotification.notDelivered"),
              },
        );
        return;
      }
      const sent = await sendOsNotification({
        title: t("desktop.permissions.testNotification.title"),
        body: t("desktop.permissions.testNotification.body"),
        // Silent OS bubble: curated preset already played above; avoid double OS chime.
        silent: true,
      });
      if (!isMountedRef.current) {
        return;
      }
      setTestNotificationState(
        sent
          ? { status: "success" }
          : {
              status: "error",
              message: t("desktop.permissions.testNotification.notDelivered"),
            },
      );
    } catch {
      if (isMountedRef.current) {
        setTestNotificationState({
          status: "error",
          message: t("desktop.permissions.testNotification.failed"),
        });
      }
    }
  }, [isDesktopApp, t]);

  useEffect(() => {
    if (!isDesktopApp) {
      return;
    }

    void refreshPermissions();
  }, [isDesktopApp, refreshPermissions]);

  return {
    isDesktopApp,
    snapshot,
    isRefreshing,
    requestingPermission,
    testNotificationState,
    refreshPermissions,
    requestPermission,
    sendTestNotification,
  };
}
