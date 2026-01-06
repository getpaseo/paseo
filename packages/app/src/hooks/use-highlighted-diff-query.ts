import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useSessionStore } from "@/stores/session-store";
import { sendRpcRequest } from "@/lib/send-rpc-request";
import { useExplorerSidebarStore } from "@/stores/explorer-sidebar-store";
import type { HighlightedDiffResponse } from "@server/server/messages";

const HIGHLIGHTED_DIFF_STALE_TIME = 30_000;

function highlightedDiffQueryKey(serverId: string, agentId: string) {
  return ["highlightedDiff", serverId, agentId] as const;
}

interface UseHighlightedDiffQueryOptions {
  serverId: string;
  agentId: string;
}

export type ParsedDiffFile = HighlightedDiffResponse["payload"]["files"][number];
export type DiffHunk = ParsedDiffFile["hunks"][number];
export type DiffLine = DiffHunk["lines"][number];
export type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

export function useHighlightedDiffQuery({ serverId, agentId }: UseHighlightedDiffQueryOptions) {
  const queryClient = useQueryClient();
  const ws = useSessionStore((state) => state.sessions[serverId]?.ws);
  const { isOpen, activeTab } = useExplorerSidebarStore();

  const query = useQuery({
    queryKey: highlightedDiffQueryKey(serverId, agentId),
    queryFn: async () => {
      if (!ws) {
        throw new Error("WebSocket not available");
      }
      const response = await sendRpcRequest(ws, {
        type: "highlighted_diff_request",
        agentId,
      });
      return response.files;
    },
    enabled: !!ws && ws.isConnected && !!agentId,
    staleTime: HIGHLIGHTED_DIFF_STALE_TIME,
    refetchInterval: 10_000,
  });

  // Revalidate when sidebar opens with "changes" tab active
  useEffect(() => {
    if (!isOpen || activeTab !== "changes" || !agentId) {
      return;
    }
    // Invalidate to trigger background refetch (shows stale data while fetching)
    queryClient.invalidateQueries({
      queryKey: highlightedDiffQueryKey(serverId, agentId),
    });
  }, [isOpen, activeTab, serverId, agentId, queryClient]);

  const refresh = useCallback(() => {
    return query.refetch();
  }, [query]);

  return {
    files: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refresh,
  };
}
