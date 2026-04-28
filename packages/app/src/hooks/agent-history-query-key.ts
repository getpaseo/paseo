export function agentHistoryQueryKey(serverId: string | null) {
  return ["agentHistory", serverId] as const;
}
