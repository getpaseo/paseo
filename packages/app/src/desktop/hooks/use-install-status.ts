import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  getCliInstallStatus,
  getSkillsSnapshot,
  installCli,
  installSkills,
  saveSkillsSelection,
  shouldUseDesktopDaemon,
  type InstallStatus,
  type SkillSelection,
  type SkillsSaveResult,
  type SkillsSnapshot,
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
  const { t } = useTranslation();
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
    message: t("desktop.integrations.cli.statusFailed"),
    logLabel: "[Integrations] Failed to load CLI status",
  });

  const installMutation = useMutation<InstallStatus, Error>({
    mutationFn: installCli,
    onError: (error) => {
      reportError({
        error,
        message: t("desktop.integrations.cli.installFailed"),
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
  status: SkillsSnapshot | null;
  isLoading: boolean;
  isWorking: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  install: () => Promise<void>;
  update: () => Promise<void>;
  uninstall: () => Promise<void>;
  saveSelection: (
    selection: SkillSelection,
    confirmedRemovals?: readonly string[],
  ) => Promise<SkillsSaveResult>;
}

export function useSkillsStatus(): SkillsStatusHookResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const reportError = useDesktopIpcErrorReporter();
  const enabled = shouldUseDesktopDaemon();

  const statusQuery = useQuery<SkillsSnapshot, Error>({
    queryKey: SKILLS_STATUS_QUERY_KEY,
    queryFn: getSkillsSnapshot,
    enabled,
    retry: false,
  });
  const { data: status, error: statusError, isLoading, refetch } = statusQuery;
  useDesktopIpcQueryErrorToast({
    error: statusQuery.error,
    message: t("desktop.integrations.skills.statusFailed"),
    logLabel: "[Integrations] Failed to load skills status",
  });

  const setStatus = useCallback(
    (next: SkillsSnapshot) => {
      queryClient.setQueryData<SkillsSnapshot>(SKILLS_STATUS_QUERY_KEY, next);
    },
    [queryClient],
  );

  const installMutation = useMutation<SkillsSnapshot, Error>({
    mutationFn: installSkills,
    onError: (error) => {
      reportError({
        error,
        message: t("desktop.integrations.skills.installFailed"),
        logLabel: "[Integrations] Failed to install skills",
      });
    },
    onSuccess: setStatus,
  });

  const updateMutation = useMutation<SkillsSnapshot, Error>({
    mutationFn: updateSkills,
    onError: (error) => {
      reportError({
        error,
        message: t("desktop.integrations.skills.updateFailed"),
        logLabel: "[Integrations] Failed to update skills",
      });
    },
    onSuccess: setStatus,
  });

  const uninstallMutation = useMutation<SkillsSnapshot, Error>({
    mutationFn: uninstallSkills,
    onError: (error) => {
      reportError({
        error,
        message: t("desktop.integrations.skills.uninstallFailed"),
        logLabel: "[Integrations] Failed to uninstall skills",
      });
    },
    onSuccess: setStatus,
  });

  const saveSelectionMutation = useMutation<
    SkillsSaveResult,
    Error,
    { selection: SkillSelection; confirmedRemovals: readonly string[] }
  >({
    mutationFn: ({ selection, confirmedRemovals }) =>
      saveSkillsSelection(selection, confirmedRemovals),
    onError: (error) => {
      reportError({
        error,
        message: t("desktop.integrations.skills.saveSelectionFailed"),
        logLabel: "[Integrations] Failed to save skills selection",
      });
    },
    onSuccess: setStatus,
  });

  const isWorking =
    installMutation.isPending ||
    updateMutation.isPending ||
    uninstallMutation.isPending ||
    saveSelectionMutation.isPending;

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

  const saveSelection = useCallback(
    async (selection: SkillSelection, confirmedRemovals: readonly string[] = []) =>
      saveSelectionMutation.mutateAsync({ selection, confirmedRemovals }),
    [saveSelectionMutation],
  );

  return {
    status: status ?? null,
    isLoading,
    isWorking,
    error:
      statusError ??
      installMutation.error ??
      updateMutation.error ??
      uninstallMutation.error ??
      saveSelectionMutation.error ??
      null,
    refresh,
    install,
    update,
    uninstall,
    saveSelection,
  };
}
