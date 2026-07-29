export function resolveProjectKey(input: {
  serverId: string;
  projectId: string;
  projectKey?: string | null;
}): string {
  if (input.projectKey) return input.projectKey;
  // COMPAT(projectKey): added in v0.2.4 on 2026-07-28; remove after 2027-01-28.
  // Older daemons used recognized remote-shaped project IDs as their grouping key. Their
  // path-shaped and opaque IDs are host-local when the new field is absent.
  return input.projectId.startsWith("remote:") ? input.projectId : frameHostProjectKey(input);
}

export function frameHostProjectKey(input: { serverId: string; projectId: string }): string {
  return `host:${input.serverId.length}:${input.serverId}:project:${input.projectId.length}:${input.projectId}`;
}
