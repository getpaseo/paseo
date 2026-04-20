import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentProvider, ProviderSnapshotEntry } from "@server/server/agent/agent-sdk-types";
import type { DaemonClient } from "@server/client/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { queryClient as singletonQueryClient } from "@/query/query-client";

function normalizeProvidersSnapshotCwdKey(cwd?: string | null): string | null {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function providersSnapshotQueryKey(serverId: string | null, cwd?: string | null) {
  return ["providersSnapshot", serverId, normalizeProvidersSnapshotCwdKey(cwd)] as const;
}

interface UseProvidersSnapshotResult {
  entries: ProviderSnapshotEntry[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isRefreshing: boolean;
  error: string | null;
  supportsSnapshot: boolean;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
  refetchIfStale: () => void;
}

interface UseProvidersSnapshotOptions {
  enabled?: boolean;
}

export function useProvidersSnapshot(
  serverId: string | null,
  cwd?: string | null,
  options: UseProvidersSnapshotOptions = {},
): UseProvidersSnapshotResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const enabled = options.enabled ?? true;
  const normalizedCwd = cwd?.trim() || undefined;
  const normalizedCwdKey = normalizeProvidersSnapshotCwdKey(normalizedCwd);
  const supportsSnapshot = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providersSnapshot === true,
  );

  const queryKey = useMemo(
    () => providersSnapshotQueryKey(serverId, normalizedCwdKey),
    [normalizedCwdKey, serverId],
  );

  const snapshotQuery = useQuery({
    queryKey,
    enabled: Boolean(enabled && supportsSnapshot && serverId && client && isConnected),
    staleTime: 60_000,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return client.getProvidersSnapshot({ cwd: normalizedCwd });
    },
  });

  const refreshMutation = useMutation({
    mutationFn: async (providers?: AgentProvider[]) => {
      if (!client) {
        return;
      }
      await client.refreshProvidersSnapshot({ cwd: normalizedCwd, providers });
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
      const messageCwdKey = normalizeProvidersSnapshotCwdKey(message.payload.cwd);
      if (messageCwdKey !== normalizedCwdKey) {
        return;
      }
      queryClient.setQueryData(queryKey, {
        entries: message.payload.entries,
        generatedAt: message.payload.generatedAt,
        requestId: "providers_snapshot_update",
      });
    });
  }, [
    client,
    enabled,
    isConnected,
    normalizedCwdKey,
    queryClient,
    queryKey,
    serverId,
    supportsSnapshot,
  ]);

  const refresh = useCallback(
    async (providers?: AgentProvider[]) => {
      await refreshSnapshot(providers);
    },
    [refreshSnapshot],
  );

  const refetchIfStale = useCallback(() => {
    void queryClient.refetchQueries({ queryKey, type: "active", stale: true });
  }, [queryClient, queryKey]);

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
  cwd?: string | null,
): void {
  const normalizedCwd = cwd?.trim() || undefined;
  const queryKey = providersSnapshotQueryKey(serverId, normalizedCwd);
  void singletonQueryClient.prefetchQuery({
    queryKey,
    staleTime: 60_000,
    queryFn: () => client.getProvidersSnapshot({ cwd: normalizedCwd }),
  });
}
