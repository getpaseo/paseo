import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n/i18next";
import {
  type DesktopDaemonStatus,
  confirmAndStopDesktopDaemon,
  startDesktopDaemon,
} from "@/desktop/daemon/desktop-daemon";
import { DaemonConnectionRegistrationError } from "@/desktop/daemon/daemon-management-error";
import { useDesktopIpcErrorReporter } from "@/desktop/hooks/desktop-ipc-error";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { upsertDesktopDaemonConnection } from "@/runtime/daemon-start-service";

/**
 * Manual daemon lifecycle: start and stop the built-in daemon without ever
 * touching the `manageBuiltInDaemon` launch preference.
 */
export function useManualDaemonLifecycle(input: {
  setStatus: (status: DesktopDaemonStatus) => void;
  refreshStatus: () => void;
}): {
  isStarting: boolean;
  isStopping: boolean;
  start: () => Promise<DesktopDaemonStatus | null>;
  stop: () => void;
} {
  const { t } = useTranslation();
  const { setStatus, refreshStatus } = input;
  const reportError = useDesktopIpcErrorReporter();

  const { mutateAsync: startDaemon, isPending: isStarting } = useMutation<
    DesktopDaemonStatus,
    Error
  >({
    mutationFn: async () => {
      const newStatus = await startDesktopDaemon("manual");
      const upsertResult = await upsertDesktopDaemonConnection(getHostRuntimeStore(), newStatus);
      if (!upsertResult.ok) {
        throw new DaemonConnectionRegistrationError(upsertResult.error);
      }
      return newStatus;
    },
    onError: (error) => {
      if (error instanceof DaemonConnectionRegistrationError) {
        refreshStatus();
      }
      reportError({
        error,
        message: i18n.t(
          error instanceof DaemonConnectionRegistrationError
            ? "desktop.daemon.management.registrationFailed"
            : "desktop.daemon.lifecycle.startFailed",
        ),
        logLabel: "[Settings] Failed to start built-in daemon",
      });
    },
    onSuccess: (newStatus) => {
      setStatus(newStatus);
      refreshStatus();
    },
  });

  const { mutate: stopDaemon, isPending: isStopping } = useMutation<
    DesktopDaemonStatus | null,
    Error
  >({
    mutationFn: () => confirmAndStopDesktopDaemon(),
    onError: (error) => {
      Alert.alert(t("desktop.daemon.lifecycle.stopFailed"), String(error));
    },
    onSuccess: (newStatus) => {
      if (newStatus) {
        setStatus(newStatus);
      }
      refreshStatus();
    },
  });

  const start = useCallback(async () => {
    if (isStarting) {
      return null;
    }
    try {
      return await startDaemon();
    } catch {
      // onError has already surfaced the failure.
      return null;
    }
  }, [isStarting, startDaemon]);

  const stop = useCallback(() => {
    if (!isStopping) {
      stopDaemon();
    }
  }, [isStopping, stopDaemon]);

  return { isStarting, isStopping, start, stop };
}
