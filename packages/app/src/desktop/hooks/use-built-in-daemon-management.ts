import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  type DesktopDaemonStatus,
  startDesktopDaemon,
  stopDesktopDaemon,
} from "@/desktop/daemon/desktop-daemon";
import {
  executeDaemonManagementToggle,
  type DaemonManagementToggleResult,
} from "@/desktop/daemon/daemon-management-toggle";
import {
  DaemonConnectionRegistrationError,
  DaemonManagementOperationError,
  getDaemonManagementErrorPresentation,
} from "@/desktop/daemon/daemon-management-error";
import { useDesktopIpcErrorReporter } from "@/desktop/hooks/desktop-ipc-error";
import type { DesktopSettings } from "@/desktop/settings/desktop-settings";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { upsertDesktopDaemonConnection } from "@/runtime/daemon-start-service";
import { confirmDialog } from "@/utils/confirm-dialog";

type DesktopDaemonSettings = DesktopSettings["daemon"];

interface UseBuiltInDaemonManagementInput {
  daemonStatus: DesktopDaemonStatus | null;
  settings: DesktopDaemonSettings;
  updateSettings: (next: Partial<DesktopDaemonSettings>) => Promise<unknown>;
  setStatus: (status: DesktopDaemonStatus) => void;
  refreshStatus: () => void;
}

interface UseBuiltInDaemonManagementResult {
  isUpdating: boolean;
  toggle: () => void;
  enable: () => Promise<DaemonManagementToggleResult | null>;
}

export function useBuiltInDaemonManagement(
  input: UseBuiltInDaemonManagementInput,
): UseBuiltInDaemonManagementResult {
  const { t } = useTranslation();
  const { daemonStatus, settings, updateSettings, setStatus, refreshStatus } = input;
  const reportError = useDesktopIpcErrorReporter();
  const {
    mutate: toggleDaemonManagement,
    mutateAsync: toggleDaemonManagementAsync,
    isPending: isUpdating,
  } = useMutation<DaemonManagementToggleResult, Error, { forceEnable: boolean }>({
    mutationFn: async ({ forceEnable }) => {
      // forceEnable takes the enable branch regardless of the persisted
      // setting — the recovery affordance must never reach the stop/confirm
      // path even if manageBuiltInDaemon was left true.
      const wasManagingDaemon = forceEnable ? false : settings.manageBuiltInDaemon;
      try {
        const result = await executeDaemonManagementToggle(wasManagingDaemon, daemonStatus, {
          confirm: () =>
            confirmDialog({
              title: t("desktop.daemon.management.pauseTitle"),
              message: t("desktop.daemon.management.pauseMessage"),
              confirmLabel: t("desktop.daemon.management.pauseAndStop"),
              cancelLabel: t("common.actions.cancel"),
              destructive: true,
            }),
          persistSettings: (next) => updateSettings(next) as Promise<void>,
          startDaemon: startDesktopDaemon,
          stopDaemon: () => stopDesktopDaemon("settings"),
        });
        if (result.kind === "enabled") {
          const upsertResult = await upsertDesktopDaemonConnection(
            getHostRuntimeStore(),
            result.newStatus,
          );
          if (!upsertResult.ok) {
            throw new DaemonConnectionRegistrationError(upsertResult.error);
          }
        }
        return result;
      } catch (error) {
        throw new DaemonManagementOperationError(
          error instanceof Error ? error : new Error(String(error)),
          wasManagingDaemon,
        );
      }
    },
    onError: (error) => {
      const presentation = getDaemonManagementErrorPresentation(
        error,
        settings.manageBuiltInDaemon,
      );
      if (presentation.refreshStatus) {
        refreshStatus();
      }
      reportError({
        error,
        message: presentation.message,
        logLabel: "[Settings] Failed to update built-in daemon management",
      });
    },
    onSuccess: (result) => {
      if (result.kind === "cancelled") {
        return;
      }
      if (result.newStatus) {
        setStatus(result.newStatus);
      }
      refreshStatus();
    },
  });

  const toggle = useCallback(() => {
    if (isUpdating) {
      return;
    }

    toggleDaemonManagement({ forceEnable: false });
  }, [isUpdating, toggleDaemonManagement]);

  const enable = useCallback(async () => {
    if (isUpdating) {
      return null;
    }

    try {
      return await toggleDaemonManagementAsync({ forceEnable: true });
    } catch {
      // onError has already surfaced the failure; callers only act on success.
      return null;
    }
  }, [isUpdating, toggleDaemonManagementAsync]);

  return { isUpdating, toggle, enable };
}
