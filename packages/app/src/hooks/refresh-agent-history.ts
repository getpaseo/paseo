import type { InfiniteData, QueryClient, QueryFilters } from "@tanstack/react-query";
import { agentHistoryQueryIncludesServer } from "./agent-history-query-key";
import type { AgentHistoryBatchPage } from "./use-agent-history";

export async function refreshAgentHistoryForDirectoryChanges(
  queryClient: QueryClient,
  serverId: string,
  agentIds: ReadonlySet<string>,
): Promise<void> {
  const affected: QueryFilters = {
    predicate: (query) => {
      if (!agentHistoryQueryIncludesServer(query.queryKey, serverId)) return false;
      const data = query.state.data as InfiniteData<AgentHistoryBatchPage> | undefined;
      return (
        query.state.fetchStatus === "fetching" ||
        (data?.pages.some((page) =>
          page.agents.some((agent) => agent.serverId === serverId && agentIds.has(agent.id)),
        ) ??
          false)
      );
    },
  };
  // Cancel pending reads explicitly. Invalidating alone reuses a pending initial read.
  const queries = new Set(queryClient.getQueryCache().findAll(affected));
  if (queries.size === 0) return;
  const matching: QueryFilters = { predicate: (query) => queries.has(query) };
  await queryClient.cancelQueries(matching);
  await queryClient.invalidateQueries(matching);
}
