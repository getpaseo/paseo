export function projectEquivalenceViewKey(projectKey: string): string {
  return projectKey;
}

export function projectPlacementViewKey(serverId: string, projectId: string): string {
  return JSON.stringify([serverId, projectId]);
}
