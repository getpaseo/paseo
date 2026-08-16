import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useReplicaQuery } from "@/data/query";
import { queryClient as singletonQueryClient } from "@/data/query-client";
import {
  providerSnapshotCache,
  ProviderSnapshotCacheMissError,
  type ProviderSnapshotCache,
} from "@/data/provider-snapshot-cache";
import { agentCommandsQueryRoot } from "@/hooks/agent-commands-query";
import {
  isProvidersSnapshotHomeScope,
  normalizeProvidersSnapshotCwd,
  providersSnapshotQueryKey,
  providersSnapshotQueryRoot,
  providersSnapshotRequestOptions,
} from "@/data/providers-snapshot";
import type { ProviderSnapshotCacheScope } from "@/data/provider-snapshot-cache";

type GetProvidersSnapshotResult = Awaited<ReturnType<DaemonClient["getProvidersSnapshot"]>>;
type RefreshProvidersSnapshotResult = Awaited<ReturnType<DaemonClient["refreshProvidersSnapshot"]>>;

export { providersSnapshotQueryKey, providersSnapshotQueryRoot };

export type ProvidersSnapshotClient = Pick<
  DaemonClient,
  "getProvidersSnapshot" | "refreshProvidersSnapshot"
>;

function providerSnapshotCacheScope(
  cwd: string | null,
  workspaceId?: string | null,
): ProviderSnapshotCacheScope {
  return workspaceId ? { type: "workspace", workspaceId } : { type: "legacy-cwd", cwd };
}

export async function fetchProvidersSnapshot(input: {
  client: ProvidersSnapshotClient;
  serverId: string;
  cwd: string | null;
  workspaceId?: string | null;
  cache?: ProviderSnapshotCache;
}): Promise<GetProvidersSnapshotResult> {
  const cache = input.cache ?? providerSnapshotCache;
  const scope = providerSnapshotCacheScope(input.cwd, input.workspaceId);
  const cached = await cache.read(input.serverId, scope);
  const snapshot = await input.client.getProvidersSnapshot(
    providersSnapshotRequestOptions({
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      ifNoneMatch: cached?.hash,
    }),
  );
  if (snapshot.notModified) {
    if (!cached) {
      throw new ProviderSnapshotCacheMissError();
    }
    return { ...snapshot, entries: cached.entries };
  }
  if (snapshot.compactSnapshot && snapshot.snapshotHash) {
    await cache.write({
      serverId: input.serverId,
      scope,
      hash: snapshot.snapshotHash,
      generatedAt: snapshot.generatedAt,
      compactSnapshot: snapshot.compactSnapshot,
    });
  }
  return snapshot;
}

export async function refreshAndApplyProvidersSnapshot(input: {
  client: ProvidersSnapshotClient;
  queryClient: QueryClient;
  serverId: string;
  cwd: string | null;
  workspaceId?: string | null;
  providers?: AgentProvider[];
  cache?: ProviderSnapshotCache;
}): Promise<RefreshProvidersSnapshotResult> {
  const refreshResult = await input.client.refreshProvidersSnapshot(
    providersSnapshotRequestOptions({
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      providers: input.providers,
    }),
  );
  const snapshot = await fetchProvidersSnapshot({
    client: input.client,
    serverId: input.serverId,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    cache: input.cache,
  });
  input.queryClient.setQueryData(
    providersSnapshotQueryKey(input.serverId, input.cwd, input.workspaceId),
    snapshot,
  );
  void input.queryClient.invalidateQueries({
    queryKey: agentCommandsQueryRoot(input.serverId),
    exact: false,
  });
  if (isProvidersSnapshotHomeScope(input.cwd)) {
    void input.queryClient.invalidateQueries({
      queryKey: providersSnapshotQueryRoot(input.serverId),
      exact: false,
    });
  }
  return refreshResult;
}

export type SelectorOpenRefetchDecision = "refetch-stale" | "refetch-always";

export function selectorOpenRefetchDecision(input: {
  entries: ProviderSnapshotEntry[] | undefined;
  selectedProvider: AgentProvider | null | undefined;
}): SelectorOpenRefetchDecision {
  if (!input.selectedProvider) {
    return "refetch-stale";
  }
  const selectedEntry = input.entries?.find((entry) => entry.provider === input.selectedProvider);
  if (!selectedEntry || selectedEntry.status === "loading") {
    return "refetch-always";
  }
  return "refetch-stale";
}

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
  workspaceId?: string | null;
}

export function useProvidersSnapshot(
  serverId: string | null,
  options: UseProvidersSnapshotOptions = {},
): UseProvidersSnapshotResult {
  const { t } = useTranslation();
  const retainedPanelActive = useRetainedPanelActive();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const targetEnabled = options.enabled ?? true;
  const enabled = targetEnabled && retainedPanelActive;
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const cwd = normalizeProvidersSnapshotCwd(options.cwd);
  const supportsSnapshot = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providersSnapshot === true,
  );

  const queryKey = useMemo(
    () => providersSnapshotQueryKey(serverId, cwd, options.workspaceId),
    [cwd, options.workspaceId, serverId],
  );

  const snapshotQuery = useReplicaQuery({
    queryKey,
    enabled: Boolean(enabled && supportsSnapshot && serverId && client && isConnected),
    pushEvent: "providers_snapshot_update",
    queryFn: async () => {
      if (!client || !serverId) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return fetchProvidersSnapshot({
        client,
        serverId,
        cwd,
        workspaceId: options.workspaceId,
      });
    },
  });

  const refreshMutation = useMutation({
    mutationFn: async (providers?: AgentProvider[]) => {
      if (!client || !serverId) {
        return;
      }
      await refreshAndApplyProvidersSnapshot({
        client,
        queryClient,
        serverId,
        cwd,
        workspaceId: options.workspaceId,
        providers,
      });
    },
  });
  const { mutateAsync: refreshSnapshot, isPending: isRefreshing } = refreshMutation;

  const refresh = useCallback(
    async (providers?: AgentProvider[]) => {
      await refreshSnapshot(providers);
    },
    [refreshSnapshot],
  );

  const refetchIfStale = useCallback(
    (selectedProvider?: AgentProvider | null) => {
      const decision = selectorOpenRefetchDecision({
        entries: snapshotQuery.data?.entries,
        selectedProvider,
      });
      if (decision === "refetch-always") {
        void queryClient.refetchQueries({ queryKey, type: "active" });
        return;
      }
      void queryClient.refetchQueries({ queryKey, type: "active", stale: true });
    },
    [queryClient, queryKey, snapshotQuery.data?.entries],
  );

  return {
    entries: targetEnabled ? (snapshotQuery.data?.entries ?? undefined) : undefined,
    isLoading: targetEnabled && snapshotQuery.isLoading,
    isFetching: targetEnabled && snapshotQuery.isFetching,
    isRefreshing: targetEnabled && isRefreshing,
    error:
      targetEnabled && snapshotQuery.error instanceof Error ? snapshotQuery.error.message : null,
    supportsSnapshot,
    refresh,
    refetchIfStale,
  };
}

export function prefetchProvidersSnapshot(
  serverId: string,
  client: DaemonClient,
  options: { cwd?: string | null; workspaceId?: string | null } = {},
): void {
  const cwd = normalizeProvidersSnapshotCwd(options.cwd);
  const queryKey = providersSnapshotQueryKey(serverId, cwd, options.workspaceId);
  void singletonQueryClient.prefetchQuery({
    queryKey,
    staleTime: Infinity,
    queryFn: () =>
      fetchProvidersSnapshot({ client, serverId, cwd, workspaceId: options.workspaceId }),
  });
}
