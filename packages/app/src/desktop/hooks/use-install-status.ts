import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCliInstallStatus,
  getSkillsStatus,
  installCli,
  installSkills,
  shouldUseDesktopDaemon,
  type InstallStatus,
  type SkillsStatus,
  uninstallSkills,
  updateSkills,
} from "@/desktop/daemon/desktop-daemon";
import {
  useDesktopIpcErrorReporter,
  useDesktopIpcQueryErrorToast,
} from "@/desktop/hooks/desktop-ipc-error";

const CLI_INSTALL_STATUS_QUERY_KEY = ["desktop", "integrations", "cli-install-status"] as const;
const SKILLS_STATUS_QUERY_KEY = ["desktop", "integrations", "skills-status"] as const;

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

export interface SkillsStatusHookResult {
  status: SkillsStatus | null;
  isLoading: boolean;
  isWorking: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  install: () => Promise<void>;
  update: () => Promise<void>;
  uninstall: () => Promise<void>;
}

export function useSkillsStatus(): SkillsStatusHookResult {
  const queryClient = useQueryClient();
  const reportError = useDesktopIpcErrorReporter();
  const enabled = shouldUseDesktopDaemon();

  const statusQuery = useQuery<SkillsStatus, Error>({
    queryKey: SKILLS_STATUS_QUERY_KEY,
    queryFn: getSkillsStatus,
    enabled,
    retry: false,
  });
  const { data: status, error: statusError, isLoading, refetch } = statusQuery;
  useDesktopIpcQueryErrorToast({
    error: statusQuery.error,
    message: "Unable to check orchestration skills status.",
    logLabel: "[Integrations] Failed to load skills status",
  });

  const setStatus = useCallback(
    (next: SkillsStatus) => {
      queryClient.setQueryData<SkillsStatus>(SKILLS_STATUS_QUERY_KEY, next);
    },
    [queryClient],
  );

  const installMutation = useMutation<SkillsStatus, Error>({
    mutationFn: installSkills,
    onError: (error) => {
      reportError({
        error,
        message: "Unable to install orchestration skills.",
        logLabel: "[Integrations] Failed to install skills",
      });
    },
    onSuccess: setStatus,
  });

  const updateMutation = useMutation<SkillsStatus, Error>({
    mutationFn: updateSkills,
    onError: (error) => {
      reportError({
        error,
        message: "Unable to update orchestration skills.",
        logLabel: "[Integrations] Failed to update skills",
      });
    },
    onSuccess: setStatus,
  });

  const uninstallMutation = useMutation<SkillsStatus, Error>({
    mutationFn: uninstallSkills,
    onError: (error) => {
      reportError({
        error,
        message: "Unable to uninstall orchestration skills.",
        logLabel: "[Integrations] Failed to uninstall skills",
      });
    },
    onSuccess: setStatus,
  });

  const isWorking =
    installMutation.isPending || updateMutation.isPending || uninstallMutation.isPending;

  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const install = useCallback(async () => {
    await installMutation.mutateAsync().catch(() => undefined);
  }, [installMutation]);

  const update = useCallback(async () => {
    await updateMutation.mutateAsync().catch(() => undefined);
  }, [updateMutation]);

  const uninstall = useCallback(async () => {
    await uninstallMutation.mutateAsync().catch(() => undefined);
  }, [uninstallMutation]);

  return {
    status: status ?? null,
    isLoading,
    isWorking,
    error:
      statusError ??
      installMutation.error ??
      updateMutation.error ??
      uninstallMutation.error ??
      null,
    refresh,
    install,
    update,
    uninstall,
  };
}
