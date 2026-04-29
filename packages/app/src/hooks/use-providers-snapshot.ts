import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProviderSnapshotEntry } from "@server/server/agent/agent-sdk-types";
import type { DaemonClient } from "@server/client/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionForServer } from "./use-session-directory";
import { queryClient as singletonQueryClient } from "@/query/query-client";

export function providersSnapshotQueryKey(serverId: string | null) {
  return ["providersSnapshot", serverId] as const;
}

export interface UseProvidersSnapshotResult {
  entries: ProviderSnapshotEntry[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  /** Alias of isFetching exposed for paseo-compat callers/tests. */
  isRefreshing: boolean;
  error: string | null;
  supportsSnapshot: boolean;
  /**
   * Force the daemon to refresh provider state. The optional providers list
   * is forwarded to the daemon when set; if omitted, the daemon refreshes all.
   */
  refresh: (providers?: string[]) => void;
  /**
   * Refresh-if-stale convenience used by selectors. The fork triggers an
   * unconditional refresh — callers historically passed the provider id to
   * scope the refetch.
   */
  refetchIfStale: (provider?: string) => void;
  invalidate: () => void;
}

export function useProvidersSnapshot(serverId: string | null): UseProvidersSnapshotResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsSnapshot = useSessionForServer(
    serverId,
    (session) => session?.serverInfo?.features?.providersSnapshot === true,
  );

  const queryKey = useMemo(() => providersSnapshotQueryKey(serverId), [serverId]);

  const snapshotQuery = useQuery({
    queryKey,
    enabled: Boolean(supportsSnapshot && serverId && client && isConnected),
    staleTime: 60_000,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return client.getProvidersSnapshot();
    },
  });

  useEffect(() => {
    if (!supportsSnapshot || !client || !isConnected || !serverId) {
      return;
    }

    return client.on("providers_snapshot_update", (message) => {
      if (message.type !== "providers_snapshot_update") {
        return;
      }
      queryClient.setQueryData(queryKey, {
        entries: message.payload.entries,
        generatedAt: message.payload.generatedAt,
        requestId: "providers_snapshot_update",
      });
    });
  }, [client, isConnected, serverId, queryClient, queryKey, supportsSnapshot]);

  const refresh = useCallback(
    (providers?: string[]) => {
      if (!client) {
        return;
      }
      if (providers && providers.length > 0) {
        void client.refreshProvidersSnapshot({ providers });
      } else {
        void client.refreshProvidersSnapshot();
      }
    },
    [client],
  );

  const refetchIfStale = useCallback(
    (_provider?: string) => {
      // The hook's TanStack query already governs staleness via staleTime;
      // exposed for paseo-compat callers that want to opportunistically
      // refresh a single provider's row.
      void queryClient.invalidateQueries({ queryKey });
    },
    [queryClient, queryKey],
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    entries: snapshotQuery.data?.entries ?? undefined,
    isLoading: snapshotQuery.isLoading,
    isFetching: snapshotQuery.isFetching,
    isRefreshing: snapshotQuery.isFetching,
    error: snapshotQuery.error instanceof Error ? snapshotQuery.error.message : null,
    supportsSnapshot,
    refresh,
    refetchIfStale,
    invalidate,
  };
}

export function prefetchProvidersSnapshot(serverId: string, client: DaemonClient): void {
  const queryKey = providersSnapshotQueryKey(serverId);
  void singletonQueryClient.prefetchQuery({
    queryKey,
    staleTime: 60_000,
    queryFn: () => client.getProvidersSnapshot(),
  });
}
