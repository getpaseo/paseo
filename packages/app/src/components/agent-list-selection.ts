export function toAgentListKey(agent: { serverId: string; id: string }): string {
  return `${agent.serverId}:${agent.id}`;
}

export function isArchivedAgentSelectable(agent: { archivedAt?: Date | null }): boolean {
  return agent.archivedAt != null;
}

export function selectAllArchivedAgentKeys(
  agents: ReadonlyArray<{ serverId: string; id: string; archivedAt?: Date | null }>,
): Set<string> {
  const keys = new Set<string>();
  for (const agent of agents) {
    if (isArchivedAgentSelectable(agent)) {
      keys.add(toAgentListKey(agent));
    }
  }
  return keys;
}

export function pruneSelectedAgentKeys(
  selectedKeys: ReadonlySet<string>,
  agents: ReadonlyArray<{ serverId: string; id: string; archivedAt?: Date | null }>,
): Set<string> {
  const selectable = selectAllArchivedAgentKeys(agents);
  const next = new Set<string>();
  for (const key of selectedKeys) {
    if (selectable.has(key)) {
      next.add(key);
    }
  }
  return next;
}
