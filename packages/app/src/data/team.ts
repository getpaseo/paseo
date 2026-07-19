export const TEAM_QUERY_ROOT = "teams";

export function teamsQueryKey(serverId: string | null) {
  return [TEAM_QUERY_ROOT, serverId] as const;
}
