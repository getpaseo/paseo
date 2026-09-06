import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
  SetDaemonConfigResponseMessage,
} from "@getpaseo/protocol/messages";
import { useReplicaQuery } from "@/data/query";
import { daemonConfigQueryKey, type DaemonConfigQueryData } from "@/data/daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface UseDaemonConfigResult {
  config: MutableDaemonConfig | null;
  overrideControlledPaths: readonly string[];
  isLoading: boolean;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<MutableDaemonConfig | undefined>;
  patchConfigWithResult: (
    patch: MutableDaemonConfigPatch,
  ) => Promise<
    | Pick<
        SetDaemonConfigResponseMessage["payload"],
        "config" | "restartRequiredPaths" | "overrideControlledPaths"
      >
    | undefined
  >;
}

export function useDaemonConfig(serverId: string | null): UseDaemonConfigResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryKey = useMemo(() => daemonConfigQueryKey(serverId), [serverId]);
  const configQuery = useReplicaQuery<DaemonConfigQueryData>({
    queryKey,
    enabled: Boolean(serverId && client && isConnected),
    pushEvent: "status:daemon_config_changed",
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.getDaemonConfig();
      return {
        config: result.config,
        overrideControlledPaths: result.overrideControlledPaths ?? [],
      };
    },
  });

  const patchConfigWithResult = useCallback(
    async (patch: MutableDaemonConfigPatch) => {
      if (!client) {
        return undefined;
      }
      const result = await client.patchDaemonConfig(patch);
      const queryData: DaemonConfigQueryData = {
        config: result.config,
        overrideControlledPaths: result.overrideControlledPaths ?? [],
      };
      queryClient.setQueryData(queryKey, queryData);
      const nextOverrideControlledPaths = result.overrideControlledPaths ?? [];
      return {
        config: result.config,
        restartRequiredPaths: result.restartRequiredPaths ?? [],
        overrideControlledPaths: nextOverrideControlledPaths,
      };
    },
    [client, queryClient, queryKey],
  );

  const patchConfig = useCallback(
    async (patch: MutableDaemonConfigPatch) => {
      const result = await patchConfigWithResult(patch);
      return result?.config;
    },
    [patchConfigWithResult],
  );

  return {
    config: configQuery.data?.config ?? null,
    overrideControlledPaths: configQuery.data?.overrideControlledPaths ?? [],
    isLoading: configQuery.isLoading,
    patchConfig,
    patchConfigWithResult,
  };
}
