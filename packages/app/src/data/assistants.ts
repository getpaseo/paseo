export const ASSISTANTS_QUERY_ROOT = "assistants";

export function assistantsQueryKey(serverId: string | null) {
  return [ASSISTANTS_QUERY_ROOT, serverId] as const;
}
