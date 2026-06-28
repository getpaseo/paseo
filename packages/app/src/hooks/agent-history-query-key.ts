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
