import type { HistoryServerQuery } from "./history-view-model";
import type { QueryClient } from "@tanstack/react-query";

export function agentHistoryQueryKey(
  serverId: string | null,
  query?: HistoryServerQuery,
  supportsPinning?: boolean,
) {
  return query
    ? ([
        "agentHistory",
        serverId,
        query,
        ...(supportsPinning === undefined ? [] : [{ supportsPinning }]),
      ] as const)
    : (["agentHistory", serverId] as const);
}

const ALL_AGENT_HISTORY_QUERY_ROOT = ["allAgentHistory"] as const;

export function allAgentHistoryQueryRootKey() {
  return ALL_AGENT_HISTORY_QUERY_ROOT;
}

export async function invalidateAgentHistoryQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  serverId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: agentHistoryQueryKey(serverId) }),
    queryClient.invalidateQueries({ queryKey: allAgentHistoryQueryRootKey() }),
  ]);
}

export async function invalidateAgentHistoryQueriesIfPinChanged(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  serverId: string,
  currentPinnedAt: Date | null | undefined,
  nextPinnedAt: Date | null,
): Promise<void> {
  if (
    currentPinnedAt !== undefined &&
    (currentPinnedAt?.getTime() ?? null) === (nextPinnedAt?.getTime() ?? null)
  ) {
    return;
  }

  await invalidateAgentHistoryQueries(queryClient, serverId);
}

export function allAgentHistoryQueryKey(
  serverIds: readonly string[],
  query?: HistoryServerQuery,
  pinningServerIds?: readonly string[],
) {
  return [
    ...ALL_AGENT_HISTORY_QUERY_ROOT,
    {
      serverIds: [...serverIds].sort(),
      ...(query ? { query } : {}),
      ...(pinningServerIds ? { pinningServerIds: [...pinningServerIds].sort() } : {}),
    },
  ] as const;
}
