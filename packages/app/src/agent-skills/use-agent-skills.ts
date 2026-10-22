import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  AgentSkillSelection,
  AgentSkillsSaveResult,
  AgentSkillsStatus,
} from "@getpaseo/protocol/messages";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export function useAgentSkills(serverId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "skillManagement");
  const queryKey = useMemo(() => ["host", serverId, "agent-skills"] as const, [serverId]);
  const reportedQueryError = useRef<Error | null>(null);
  const report = useCallback(
    (message: string, error: Error) => {
      console.error(`[Agent skills: ${serverId}]`, error);
      toast.error(message);
    },
    [serverId, toast],
  );
  const query = useFetchQuery<AgentSkillsStatus, Error>({
    queryKey,
    queryFn: () => {
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.getAgentSkillsStatus();
    },
    enabled: supported && client !== null,
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });
  useEffect(() => {
    if (!query.error || query.error === reportedQueryError.current) return;
    reportedQueryError.current = query.error;
    report(t("settings.host.skills.statusFailed"), query.error);
  }, [query.error, report, t]);
  const setStatus = useCallback(
    (status: AgentSkillsStatus) => queryClient.setQueryData(queryKey, status),
    [queryClient, queryKey],
  );
  const reconcile = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.reconcileAgentSkills();
    },
    onSuccess: setStatus,
    onError: (error: Error) => report(t("settings.host.skills.updateFailed"), error),
  });
  const uninstall = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.uninstallAgentSkills();
    },
    onSuccess: setStatus,
    onError: (error: Error) => report(t("settings.host.skills.uninstallFailed"), error),
  });
  const save = useMutation<
    AgentSkillsSaveResult,
    Error,
    { selection: AgentSkillSelection; confirmedRemovals: readonly string[] }
  >({
    mutationFn: async ({ selection, confirmedRemovals }) => {
      if (!client) throw new Error(t("settings.host.skills.unavailable"));
      return client.saveAgentSkillsSelection(selection, confirmedRemovals);
    },
    onSuccess: setStatus,
    onError: (error) => report(t("settings.host.skills.saveSelectionFailed"), error),
  });
  const isWorking = reconcile.isPending || uninstall.isPending || save.isPending;
  const refetch = query.refetch;
  const reconcileAsync = reconcile.mutateAsync;
  const uninstallAsync = uninstall.mutateAsync;
  const saveAsync = save.mutateAsync;
  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);
  const runReconcile = useCallback(async () => {
    await reconcileAsync().catch(() => undefined);
  }, [reconcileAsync]);
  const runUninstall = useCallback(async () => {
    await uninstallAsync().catch(() => undefined);
  }, [uninstallAsync]);
  const saveSelection = useCallback(
    (selection: AgentSkillSelection, confirmedRemovals: readonly string[] = []) =>
      saveAsync({ selection, confirmedRemovals }),
    [saveAsync],
  );
  return {
    connected,
    supported,
    status: query.data ?? null,
    isLoading: query.isLoading,
    isWorking,
    refresh,
    reconcile: runReconcile,
    uninstall: runUninstall,
    saveSelection,
  };
}
