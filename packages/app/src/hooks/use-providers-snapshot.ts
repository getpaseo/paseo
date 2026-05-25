import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentProvider, ProviderSnapshotEntry } from "@server/server/agent/agent-sdk-types";
import type { DaemonClient } from "@server/client/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { queryClient as singletonQueryClient } from "@/query/query-client";
import {
  isProvidersSnapshotHomeScope,
  normalizeProvidersSnapshotCwd,
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
  providersSnapshotRequestOptions,
} from "@/hooks/providers-snapshot-query";

export { providersSnapshotQueryKey, providersSnapshotQueryRoot };

interface UseProvidersSnapshotResult {
  entries: ProviderSnapshotEntry[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isRefreshing: boolean;
  error: string | null;
  supportsSnapshot: boolean;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
  refetchIfStale: (selectedProvider?: AgentProvider | null) => void;
}

interface UseProvidersSnapshotOptions {
  enabled?: boolean;
  cwd?: string | null;
}

export function useProvidersSnapshot(
  serverId: string | null,
  options: UseProvidersSnapshotOptions = {},
): UseProvidersSnapshotResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const enabled = options.enabled ?? true;
  const cwd = normalizeProvidersSnapshotCwd(options.cwd);
  const supportsSnapshot = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providersSnapshot === true,
  );

  const queryKey = useMemo(() => providersSnapshotQueryKey(serverId, cwd), [cwd, serverId]);
  const queryRoot = useMemo(() => providersSnapshotQueryRoot(serverId), [serverId]);
  const requestOptions = useMemo(() => providersSnapshotRequestOptions({ cwd }), [cwd]);

  const snapshotQuery = useQuery({
    queryKey,
    enabled: Boolean(enabled && supportsSnapshot && serverId && client && isConnected),
    staleTime: 60_000,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return client.getProvidersSnapshot(requestOptions);
    },
  });

  const refreshMutation = useMutation({
    mutationFn: async (providers?: AgentProvider[]) => {
      if (!client) {
        return;
      }
      await client.refreshProvidersSnapshot(providersSnapshotRequestOptions({ cwd, providers }));
    },
  });
  const { mutateAsync: refreshSnapshot, isPending: isRefreshing } = refreshMutation;

  useEffect(() => {
    if (!enabled || !supportsSnapshot || !client || !isConnected || !serverId) {
      return;
    }

    return client.on("providers_snapshot_update", (message) => {
      if (message.type !== "providers_snapshot_update") {
        return;
      }
      const updateQueryKey = providersSnapshotQueryKey(serverId, message.payload.cwd);
      queryClient.setQueryData(updateQueryKey, {
        entries: message.payload.entries,
        generatedAt: message.payload.generatedAt,
        requestId: "providers_snapshot_update",
      });
      const shouldRefetch = message.payload.entries.some((entry) => entry.status === "loading");
      if (shouldRefetch) {
        void queryClient.invalidateQueries({
          queryKey: updateQueryKey,
          exact: true,
          refetchType: "active",
        });
      }
    });
  }, [client, enabled, isConnected, queryClient, serverId, supportsSnapshot]);

  const refresh = useCallback(
    async (providers?: AgentProvider[]) => {
      if (!client) {
        return;
      }
      await refreshSnapshot(providers);
      if (isProvidersSnapshotHomeScope(cwd)) {
        queryClient.removeQueries({ queryKey: queryRoot, exact: false });
      }
      const snapshot = await client.getProvidersSnapshot(requestOptions);
      queryClient.setQueryData(queryKey, snapshot);
    },
    [client, cwd, queryClient, queryKey, queryRoot, refreshSnapshot, requestOptions],
  );

  const refetchIfStale = useCallback(
    (selectedProvider?: AgentProvider | null) => {
      if (!selectedProvider) {
        void queryClient.refetchQueries({ queryKey, type: "active", stale: true });
        return;
      }

      const selectedEntry = snapshotQuery.data?.entries.find(
        (entry) => entry.provider === selectedProvider,
      );

      if (!selectedEntry || selectedEntry.status === "loading") {
        void queryClient.refetchQueries({ queryKey, type: "active" });
        return;
      }

      void queryClient.refetchQueries({ queryKey, type: "active", stale: true });
    },
    [queryClient, queryKey, snapshotQuery.data?.entries],
  );

  return {
    entries: snapshotQuery.data?.entries ?? undefined,
    isLoading: snapshotQuery.isLoading,
    isFetching: snapshotQuery.isFetching,
    isRefreshing,
    error: snapshotQuery.error instanceof Error ? snapshotQuery.error.message : null,
    supportsSnapshot,
    refresh,
    refetchIfStale,
  };
}

export function prefetchProvidersSnapshot(
  serverId: string,
  client: DaemonClient,
  options: { cwd?: string | null } = {},
): void {
  const cwd = normalizeProvidersSnapshotCwd(options.cwd);
  const queryKey = providersSnapshotQueryKey(serverId, cwd);
  const requestOptions = providersSnapshotRequestOptions({ cwd });
  void singletonQueryClient.prefetchQuery({
    queryKey,
    staleTime: 60_000,
    queryFn: () => client.getProvidersSnapshot(requestOptions),
  });
}
