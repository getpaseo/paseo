export const SKILL_QUERY_ROOT = "skills";

export function skillsQueryKey(serverId: string | null) {
  return [SKILL_QUERY_ROOT, serverId] as const;
}
