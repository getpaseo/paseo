import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { useReplicaQuery } from "@/data/query";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface UseDaemonConfigResult {
  config: MutableDaemonConfig | null;
  isLoading: boolean;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<MutableDaemonConfig | undefined>;
}

export function useDaemonConfig(serverId: string | null): UseDaemonConfigResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryKey = useMemo(() => daemonConfigQueryKey(serverId), [serverId]);

  const configQuery = useReplicaQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected),
    pushEvent: "status:daemon_config_changed",
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.getDaemonConfig();
      return result.config;
    },
  });

  const patchConfig = useCallback(
    async (patch: MutableDaemonConfigPatch) => {
      if (!client) {
        return undefined;
      }
      const result = await client.patchDaemonConfig(patch);
      queryClient.setQueryData(queryKey, result.config);
      return result.config;
    },
    [client, queryClient, queryKey],
  );

  return {
    config: configQuery.data ?? null,
    isLoading: configQuery.isLoading,
    patchConfig,
  };
}
