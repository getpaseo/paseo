export function resolveProjectGroupKey(input: {
  serverId: string;
  projectId: string;
  projectGroupKey?: string | null;
}): string {
  if (input.projectGroupKey) return input.projectGroupKey;
  // COMPAT(projectGroupKey): added in v0.2.4 on 2026-07-28; remove after 2027-01-28.
  // Older daemons used remote/path-shaped project IDs as their grouping key. New opaque IDs
  // must remain host-local when the new field is absent.
  return input.projectId.startsWith("prj_") ? frameHostProjectKey(input) : input.projectId;
}

export function frameHostProjectKey(input: { serverId: string; projectId: string }): string {
  return `host:${input.serverId.length}:${input.serverId}:project:${input.projectId.length}:${input.projectId}`;
}
