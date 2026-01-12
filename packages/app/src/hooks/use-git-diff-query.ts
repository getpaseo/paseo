import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useExplorerSidebarStore } from "@/stores/explorer-sidebar-store";

const GIT_DIFF_STALE_TIME = 30_000;

function gitDiffQueryKey(serverId: string, agentId: string) {
  return ["gitDiff", serverId, agentId] as const;
}

interface UseGitDiffQueryOptions {
  serverId: string;
  agentId: string;
}

export function useGitDiffQuery({ serverId, agentId }: UseGitDiffQueryOptions) {
  const queryClient = useQueryClient();
  const client = useSessionStore(
    (state) => state.sessions[serverId]?.client ?? null
  );
  const isConnected = useSessionStore(
    (state) => state.sessions[serverId]?.connection.isConnected ?? false
  );
  const { isOpen, activeTab } = useExplorerSidebarStore();

  const query = useQuery({
    queryKey: gitDiffQueryKey(serverId, agentId),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      const response = await client.getGitDiff(agentId);
      return response.diff;
    },
    enabled: !!client && isConnected && !!agentId,
    staleTime: GIT_DIFF_STALE_TIME,
    refetchInterval: 10_000,
  });

  // Revalidate when sidebar opens with "changes" tab active
  useEffect(() => {
    if (!isOpen || activeTab !== "changes" || !agentId) {
      return;
    }
    // Invalidate to trigger background refetch (shows stale data while fetching)
    queryClient.invalidateQueries({
      queryKey: gitDiffQueryKey(serverId, agentId),
    });
  }, [isOpen, activeTab, serverId, agentId, queryClient]);

  const refresh = useCallback(() => {
    return query.refetch();
  }, [query]);

  return {
    diff: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refresh,
  };
}
