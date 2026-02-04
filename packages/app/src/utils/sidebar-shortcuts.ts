export interface SidebarShortcutSection {
  projectKey: string;
  agents: Array<{ serverId: string; id: string }>;
}

export function parseSidebarAgentKey(
  key: string
): { serverId: string; agentId: string } | null {
  const sep = key.indexOf(":");
  if (sep === -1) {
    return null;
  }
  const serverId = key.slice(0, sep);
  const agentId = key.slice(sep + 1);
  if (!serverId || !agentId) {
    return null;
  }
  return { serverId, agentId };
}

export function deriveSidebarShortcutAgentKeys(
  sections: SidebarShortcutSection[],
  collapsedProjectKeys: ReadonlySet<string>,
  limit = 9
): string[] {
  const keys: string[] = [];
  const max = Math.max(0, Math.floor(limit));
  if (max === 0) {
    return keys;
  }

  for (const section of sections) {
    if (collapsedProjectKeys.has(section.projectKey)) {
      continue;
    }
    for (const agent of section.agents) {
      keys.push(`${agent.serverId}:${agent.id}`);
      if (keys.length >= max) {
        return keys;
      }
    }
  }

  return keys;
}

