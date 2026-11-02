import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  getCliInstallStatus,
  installCli,
  shouldUseDesktopDaemon,
  uninstallCli,
  type InstallStatus,
} from "@/desktop/daemon/desktop-daemon";
import {
  useDesktopIpcErrorReporter,
  useDesktopIpcQueryErrorToast,
} from "@/desktop/hooks/desktop-ipc-error";

const CLI_INSTALL_STATUS_QUERY_KEY = ["desktop", "integrations", "cli-install-status"] as const;

interface CliInstall {
  /** False outside the desktop app: the CLI installs on the machine running the app. */
  available: boolean;
  status: InstallStatus | null;
  isLoading: boolean;
  isWorking: boolean;
  /** Installs or removes the CLI; resolves to whether it worked. Failures are reported. */
  setInstalled: (installed: boolean) => Promise<boolean>;
  refresh: () => void;
}

export function useCliInstall(): CliInstall {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const reportError = useDesktopIpcErrorReporter();
  const available = shouldUseDesktopDaemon();

  const statusQuery = useQuery<InstallStatus, Error>({
    queryKey: CLI_INSTALL_STATUS_QUERY_KEY,
    queryFn: getCliInstallStatus,
    enabled: available,
    retry: false,
  });
  const { data: installStatus, isLoading, refetch } = statusQuery;
  useDesktopIpcQueryErrorToast({
    error: statusQuery.error,
    message: t("desktop.integrations.cli.statusFailed"),
    logLabel: "[Integrations] Failed to load CLI status",
  });

  const mutation = useMutation<InstallStatus, Error, boolean>({
    mutationFn: (installed) => (installed ? installCli() : uninstallCli()),
    onError: (error, installed) => {
      reportError({
        error,
        message: installed
          ? t("desktop.integrations.cli.installFailed")
          : t("desktop.integrations.cli.uninstallFailed"),
        logLabel: installed
          ? "[Integrations] Failed to install CLI"
          : "[Integrations] Failed to uninstall CLI",
      });
    },
    onSuccess: (nextStatus) => {
      queryClient.setQueryData<InstallStatus>(CLI_INSTALL_STATUS_QUERY_KEY, nextStatus);
    },
  });
  const { mutateAsync, isPending } = mutation;

  const setInstalled = useCallback(
    (installed: boolean) =>
      mutateAsync(installed).then(
        (status) => status.installed === installed,
        () => false,
      ),
    [mutateAsync],
  );
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    available,
    status: installStatus ?? null,
    isLoading,
    isWorking: isPending,
    setInstalled,
    refresh,
  };
}
