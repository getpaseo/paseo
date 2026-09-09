import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { useReplicaQuery } from "@/data/query";
import { daemonConfigQueryOptions, patchDaemonConfig } from "@/data/daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface UseDaemonConfigResult {
  config: MutableDaemonConfig | null;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<MutableDaemonConfig | undefined>;
}

export function useDaemonConfig(serverId: string | null): UseDaemonConfigResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const configQuery = useReplicaQuery({
    ...daemonConfigQueryOptions(serverId, client, t("workspace.terminal.hostDisconnected")),
    enabled: Boolean(serverId && client && isConnected),
  });

  const patchConfig = useCallback(
    (patch: MutableDaemonConfigPatch) =>
      patchDaemonConfig({ serverId, client, queryClient, patch }),
    [client, queryClient, serverId],
  );

  // Depends on the query's own `refetch`, which React Query keeps stable, so
  // consumers can memoize on this callback.
  const refetchQuery = configQuery.refetch;
  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);

  return {
    config: configQuery.data ?? null,
    isLoading: configQuery.isLoading,
    isError: configQuery.isError,
    refetch,
    patchConfig,
  };
}
