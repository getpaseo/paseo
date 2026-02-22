import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDesktopPermissionSnapshot,
  requestDesktopPermission,
  shouldShowDesktopPermissionSection,
  type DesktopPermissionKind,
  type DesktopPermissionSnapshot,
} from "@/desktop/permissions/desktop-permissions";

export interface UseDesktopPermissionsReturn {
  isDesktop: boolean;
  snapshot: DesktopPermissionSnapshot | null;
  isRefreshing: boolean;
  requestingPermission: DesktopPermissionKind | null;
  refreshPermissions: () => Promise<void>;
  requestPermission: (kind: DesktopPermissionKind) => Promise<void>;
}

const EMPTY_NOTIFICATION_STATUS = {
  state: "unknown" as const,
  detail: "Notification status has not been checked yet.",
};

const EMPTY_MICROPHONE_STATUS = {
  state: "unknown" as const,
  detail: "Microphone status has not been checked yet.",
};

export function useDesktopPermissions(): UseDesktopPermissionsReturn {
  const isDesktop = shouldShowDesktopPermissionSection();
  const isMountedRef = useRef(true);
  const [snapshot, setSnapshot] = useState<DesktopPermissionSnapshot | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [requestingPermission, setRequestingPermission] = useState<DesktopPermissionKind | null>(
    null
  );

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshPermissions = useCallback(async () => {
    if (!isDesktop) {
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
  }, [isDesktop]);

  const requestPermission = useCallback(
    async (kind: DesktopPermissionKind) => {
      if (!isDesktop) {
        return;
      }

      setRequestingPermission(kind);
      try {
        const status = await requestDesktopPermission({ kind });
        if (!isMountedRef.current) {
          return;
        }

        setSnapshot((previous) => {
          const base: DesktopPermissionSnapshot =
            previous ?? {
              checkedAt: Date.now(),
              notifications: EMPTY_NOTIFICATION_STATUS,
              microphone: EMPTY_MICROPHONE_STATUS,
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
    [isDesktop, refreshPermissions]
  );

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    void refreshPermissions();
  }, [isDesktop, refreshPermissions]);

  return {
    isDesktop,
    snapshot,
    isRefreshing,
    requestingPermission,
    refreshPermissions,
    requestPermission,
  };
}
