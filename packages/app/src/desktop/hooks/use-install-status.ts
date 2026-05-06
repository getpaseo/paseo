import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCliInstallStatus,
  getSkillsInstallStatus,
  installCli,
  installSkills,
  shouldUseDesktopDaemon,
  type InstallStatus,
} from "@/desktop/daemon/desktop-daemon";
import {
  useDesktopIpcErrorReporter,
  useDesktopIpcQueryErrorToast,
} from "@/desktop/hooks/desktop-ipc-error";

const CLI_INSTALL_STATUS_QUERY_KEY = ["desktop", "integrations", "cli-install-status"] as const;
const SKILLS_INSTALL_STATUS_QUERY_KEY = [
  "desktop",
  "integrations",
  "skills-install-status",
] as const;

interface DesktopInstallHookResult {
  status: InstallStatus | null;
  isLoading: boolean;
  isInstalling: boolean;
  error: Error | null;
  install: () => void;
  refresh: () => void;
}

export function useCliInstall(): DesktopInstallHookResult {
  const queryClient = useQueryClient();
  const reportError = useDesktopIpcErrorReporter();
  const enabled = shouldUseDesktopDaemon();

  const statusQuery = useQuery<InstallStatus, Error>({
    queryKey: CLI_INSTALL_STATUS_QUERY_KEY,
    queryFn: getCliInstallStatus,
    enabled,
    retry: false,
  });
  const { data: installStatus, error: statusError, isLoading, refetch } = statusQuery;
  useDesktopIpcQueryErrorToast({
    error: statusQuery.error,
    message: "Unable to check CLI install status.",
    logLabel: "[Integrations] Failed to load CLI status",
  });

  const installMutation = useMutation<InstallStatus, Error>({
    mutationFn: installCli,
    onError: (error) => {
      reportError({
        error,
        message: "Unable to install the Paseo CLI.",
        logLabel: "[Integrations] Failed to install CLI",
      });
    },
    onSuccess: (nextStatus) => {
      queryClient.setQueryData<InstallStatus>(CLI_INSTALL_STATUS_QUERY_KEY, nextStatus);
      void queryClient.invalidateQueries({ queryKey: CLI_INSTALL_STATUS_QUERY_KEY });
    },
  });
  const { error: installError, isPending: isInstalling, mutate: install } = installMutation;

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    status: installStatus ?? null,
    isLoading,
    isInstalling,
    error: statusError ?? installError ?? null,
    install,
    refresh,
  };
}

export function useSkillsInstall(): DesktopInstallHookResult {
  const queryClient = useQueryClient();
  const reportError = useDesktopIpcErrorReporter();
  const enabled = shouldUseDesktopDaemon();

  const statusQuery = useQuery<InstallStatus, Error>({
    queryKey: SKILLS_INSTALL_STATUS_QUERY_KEY,
    queryFn: getSkillsInstallStatus,
    enabled,
    retry: false,
  });
  const { data: installStatus, error: statusError, isLoading, refetch } = statusQuery;
  useDesktopIpcQueryErrorToast({
    error: statusQuery.error,
    message: "Unable to check orchestration skills install status.",
    logLabel: "[Integrations] Failed to load skills status",
  });

  const installMutation = useMutation<InstallStatus, Error>({
    mutationFn: installSkills,
    onError: (error) => {
      reportError({
        error,
        message: "Unable to install orchestration skills.",
        logLabel: "[Integrations] Failed to install skills",
      });
    },
    onSuccess: (nextStatus) => {
      queryClient.setQueryData<InstallStatus>(SKILLS_INSTALL_STATUS_QUERY_KEY, nextStatus);
      void queryClient.invalidateQueries({ queryKey: SKILLS_INSTALL_STATUS_QUERY_KEY });
    },
  });
  const { error: installError, isPending: isInstalling, mutate: install } = installMutation;

  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    status: installStatus ?? null,
    isLoading,
    isInstalling,
    error: statusError ?? installError ?? null,
    install,
    refresh,
  };
}
