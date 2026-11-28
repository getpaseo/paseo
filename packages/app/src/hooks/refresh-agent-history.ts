import type { InfiniteData, QueryClient, QueryFilters } from "@tanstack/react-query";
import { agentHistoryQueryIncludesServer } from "./agent-history-query-key";
import type { AgentHistoryBatchPage } from "./use-agent-history";

export async function refreshAgentHistoryForDirectoryChanges(
  queryClient: QueryClient,
  serverId: string,
  agentIds: ReadonlySet<string>,
): Promise<void> {
  const queries = queryClient.getQueryCache().findAll({
    predicate: (query) => {
      if (!agentHistoryQueryIncludesServer(query.queryKey, serverId)) return false;
      // A restored row can move ahead of the loaded pages' cursor.
      if (query.isActive()) return true;
      const data = query.state.data as InfiniteData<AgentHistoryBatchPage> | undefined;
      return (
        data?.pages.some((page) =>
          page.agents.some((agent) => agent.serverId === serverId && agentIds.has(agent.id)),
        ) ?? false
      );
    },
  });
  await Promise.all(
    queries.map(async (query) => {
      const matching: QueryFilters = { predicate: (candidate) => candidate === query };
      if (query.state.fetchStatus === "fetching") {
        if (query.state.data) {
          // Let Load more finish, then refresh the new set of pages and their cursors.
          await query.promise?.catch(() => undefined);
        } else {
          await queryClient.cancelQueries(matching);
        }
      }
      await queryClient.invalidateQueries(matching, { cancelRefetch: false });
    }),
  );
}
