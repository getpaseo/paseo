export function agentHistoryQueryKey(serverId: string | null) {
  return ["agentHistory", serverId] as const;
}

const ALL_AGENT_HISTORY_QUERY_ROOT = ["allAgentHistory"] as const;

export function allAgentHistoryQueryRootKey() {
  return ALL_AGENT_HISTORY_QUERY_ROOT;
}

export function allAgentHistoryQueryKey(serverIds: readonly string[]) {
  return [...ALL_AGENT_HISTORY_QUERY_ROOT, ...[...serverIds].sort()] as const;
}

export function agentHistoryQueryIncludesServer(queryKey: readonly unknown[], serverId: string) {
  const [hostHistory, hostId] = agentHistoryQueryKey(serverId);
  if (queryKey[0] === hostHistory) return queryKey[1] === hostId;
  // The final part of an all-host query key is the search term.
  return (
    queryKey[0] === ALL_AGENT_HISTORY_QUERY_ROOT[0] && queryKey.slice(1, -1).includes(serverId)
  );
}
