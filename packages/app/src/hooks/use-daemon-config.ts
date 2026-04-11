import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
} from "@server/shared/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export function daemonConfigQueryKey(serverId: string | null) {
  return ["daemon-config", serverId] as const;
}

interface UseDaemonConfigResult {
  config: MutableDaemonConfig | null;
  isLoading: boolean;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<MutableDaemonConfig | undefined>;
}

export function useDaemonConfig(serverId: string | null): UseDaemonConfigResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryKey = useMemo(() => daemonConfigQueryKey(serverId), [serverId]);

  const configQuery = useQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected),
    staleTime: Infinity,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const result = await client.getDaemonConfig();
      return result.config;
    },
  });

  useEffect(() => {
    if (!client || !isConnected || !serverId) {
      return;
    }

    return client.on("status", (message) => {
      if (message.type !== "status") {
        return;
      }
      if (message.payload.status !== "daemon_config_changed") {
        return;
      }
      queryClient.setQueryData(queryKey, message.payload.config as MutableDaemonConfig);
    });
  }, [client, isConnected, queryClient, queryKey, serverId]);

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
