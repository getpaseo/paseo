export const MCP_QUERY_ROOT = "mcpServers";

export function mcpServersQueryKey(serverId: string | null) {
  return [MCP_QUERY_ROOT, serverId] as const;
}
