import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LarkChannelStatus } from "@getpaseo/protocol/messages";
import type { ConfigureLarkChannelOptions } from "@getpaseo/client";
import { larkChannelQueryKey } from "@/data/lark-channel";
import { useReplicaQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface UseLarkChannelResult {
  status: LarkChannelStatus | null;
  isLoading: boolean;
  isConnected: boolean;
  error: Error | null;
  configure: (input: ConfigureLarkChannelOptions) => Promise<LarkChannelStatus>;
  deleteBot: (botId: string) => Promise<LarkChannelStatus>;
  testConnection: (botId?: string | null) => Promise<LarkChannelStatus>;
  setEnabled: (enabled: boolean, botId?: string | null) => Promise<LarkChannelStatus>;
  approvePairing: (code: string, botId?: string | null) => Promise<LarkChannelStatus>;
  rejectPairing: (code: string, botId?: string | null) => Promise<LarkChannelStatus>;
  revokeUser: (userId: string, botId?: string | null) => Promise<LarkChannelStatus>;
  isMutating: boolean;
  mutationError: Error | null;
}

function requireStatus(status: LarkChannelStatus | null, fallback: string): LarkChannelStatus {
  if (!status) {
    throw new Error(fallback);
  }
  return status;
}

export interface UseLarkChannelOptions {
  enabled?: boolean;
}

export function useLarkChannel(
  serverId: string,
  options: UseLarkChannelOptions = {},
): UseLarkChannelResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => larkChannelQueryKey(serverId), [serverId]);
  const queryEnabled = Boolean((options.enabled ?? true) && client && isConnected);
  const lastRefreshKeyRef = useRef<string | null>(null);

  const query = useReplicaQuery({
    queryKey,
    pushEvent: "channel.lark.status_changed",
    enabled: queryEnabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is disconnected");
      }
      const result = await client.getLarkChannelStatus();
      if (result.error) {
        throw new Error(result.error);
      }
      return requireStatus(result.status, "Lark channel status is unavailable");
    },
  });

  useEffect(() => {
    if (!queryEnabled) {
      lastRefreshKeyRef.current = null;
      return;
    }
    const refreshKey = `${serverId}:lark-channel`;
    if (lastRefreshKeyRef.current === refreshKey) {
      return;
    }
    lastRefreshKeyRef.current = refreshKey;
    void query.refetch();
  }, [query, queryEnabled, serverId]);

  const applyStatus = useCallback(
    (status: LarkChannelStatus) => {
      queryClient.setQueryData(queryKey, status);
      return status;
    },
    [queryClient, queryKey],
  );

  const mutation = useMutation({
    mutationFn: async (operation: () => Promise<LarkChannelStatus>) => operation(),
    onSuccess: applyStatus,
  });

  const run = useCallback(
    async (
      operation: () => Promise<{ status: LarkChannelStatus | null; error: string | null }>,
    ) => {
      return mutation.mutateAsync(async () => {
        const result = await operation();
        if (result.error) {
          throw new Error(result.error);
        }
        return requireStatus(result.status, "Lark channel status is unavailable");
      });
    },
    [mutation],
  );

  const configure = useCallback(
    (input: ConfigureLarkChannelOptions) => {
      if (!client) {
        return Promise.reject(new Error("Host is disconnected"));
      }
      return run(() => client.configureLarkChannel(input));
    },
    [client, run],
  );

  const deleteBot = useCallback(
    (botId: string) => {
      if (!client) {
        return Promise.reject(new Error("Host is disconnected"));
      }
      return run(() => client.deleteLarkChannelBot({ botId }));
    },
    [client, run],
  );

  const testConnection = useCallback(
    (botId?: string | null) => {
      if (!client) {
        return Promise.reject(new Error("Host is disconnected"));
      }
      return run(() => client.testLarkChannel({ botId: botId ?? undefined }));
    },
    [client, run],
  );

  const setEnabled = useCallback(
    (enabled: boolean, botId?: string | null) => {
      if (!client) {
        return Promise.reject(new Error("Host is disconnected"));
      }
      return run(() => client.setLarkChannelEnabled({ enabled, botId: botId ?? undefined }));
    },
    [client, run],
  );

  const approvePairing = useCallback(
    (code: string, botId?: string | null) => {
      if (!client) {
        return Promise.reject(new Error("Host is disconnected"));
      }
      return run(() => client.approveLarkPairing({ code, botId: botId ?? undefined }));
    },
    [client, run],
  );

  const rejectPairing = useCallback(
    (code: string, botId?: string | null) => {
      if (!client) {
        return Promise.reject(new Error("Host is disconnected"));
      }
      return run(() => client.rejectLarkPairing({ code, botId: botId ?? undefined }));
    },
    [client, run],
  );

  const revokeUser = useCallback(
    (userId: string, botId?: string | null) => {
      if (!client) {
        return Promise.reject(new Error("Host is disconnected"));
      }
      return run(() => client.revokeLarkUser({ userId, botId: botId ?? undefined }));
    },
    [client, run],
  );

  return {
    status: query.data ?? null,
    isLoading: query.isLoading && !query.error,
    isConnected,
    error: query.error,
    configure,
    deleteBot,
    testConnection,
    setEnabled,
    approvePairing,
    rejectPairing,
    revokeUser,
    isMutating: mutation.isPending,
    mutationError: mutation.error,
  };
}
