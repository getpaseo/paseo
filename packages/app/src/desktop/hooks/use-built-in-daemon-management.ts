import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { i18n } from "@/i18n/i18next";
import { executeDaemonManagementToggle } from "@/desktop/daemon/daemon-management-toggle";
import { useDesktopIpcErrorReporter } from "@/desktop/hooks/desktop-ipc-error";
import type { DesktopSettings } from "@/desktop/settings/desktop-settings";

type DesktopDaemonSettings = DesktopSettings["daemon"];

interface UseBuiltInDaemonManagementInput {
  settings: DesktopDaemonSettings;
  updateSettings: (next: Partial<DesktopDaemonSettings>) => Promise<unknown>;
}

interface UseBuiltInDaemonManagementResult {
  isUpdating: boolean;
  toggle: () => void;
}

/**
 * Toggles the "start the built-in daemon at launch" preference. The daemon
 * itself is unaffected; use the manual lifecycle controls to start or stop it.
 */
export function useBuiltInDaemonManagement(
  input: UseBuiltInDaemonManagementInput,
): UseBuiltInDaemonManagementResult {
  const { settings, updateSettings } = input;
  const reportError = useDesktopIpcErrorReporter();
  const { mutate: toggleDaemonManagement, isPending: isUpdating } = useMutation<
    unknown,
    Error,
    void
  >({
    mutationFn: () =>
      executeDaemonManagementToggle(settings.manageBuiltInDaemon, {
        persistSettings: (next) => updateSettings(next) as Promise<void>,
      }),
    onError: (error) => {
      reportError({
        error,
        message: i18n.t("desktop.daemon.management.updateFailed"),
        logLabel: "[Settings] Failed to update built-in daemon management",
      });
    },
  });

  const toggle = useCallback(() => {
    if (isUpdating) {
      return;
    }

    toggleDaemonManagement();
  }, [isUpdating, toggleDaemonManagement]);

  return { isUpdating, toggle };
}
