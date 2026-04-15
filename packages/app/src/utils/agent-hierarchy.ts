const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

type HierarchyAgent = {
  id: string;
  labels: Record<string, string>;
  pendingPermissions?: ReadonlyArray<unknown>;
};

export function getParentAgentId(agent: Pick<HierarchyAgent, "labels">): string | null {
  const parentId = agent.labels[PARENT_AGENT_ID_LABEL];
  if (typeof parentId !== "string") {
    return null;
  }

  const normalized = parentId.trim();
  return normalized.length > 0 ? normalized : null;
}

export function isAgentInSubtree(
  agentsById: ReadonlyMap<string, Pick<HierarchyAgent, "id" | "labels">>,
  candidateAgentId: string,
  ancestorAgentId: string,
): boolean {
  let currentAgentId: string | null = candidateAgentId;
  const visited = new Set<string>();

  while (currentAgentId) {
    if (currentAgentId === ancestorAgentId) {
      return true;
    }

    if (visited.has(currentAgentId)) {
      return false;
    }
    visited.add(currentAgentId);

    const currentAgent = agentsById.get(currentAgentId);
    if (!currentAgent) {
      return false;
    }

    currentAgentId = getParentAgentId(currentAgent);
  }

  return false;
}

export function buildSubtreePendingPermissionCounts(
  agents: Iterable<HierarchyAgent>,
): Map<string, number> {
  const ownCounts = new Map<string, number>();
  const counts = new Map<string, number>();
  const parentById = new Map<string, string | null>();

  for (const agent of agents) {
    const ownCount = agent.pendingPermissions?.length ?? 0;
    ownCounts.set(agent.id, ownCount);
    counts.set(agent.id, ownCount);
    parentById.set(agent.id, getParentAgentId(agent));
  }

  for (const [agentId, ownCount] of ownCounts.entries()) {
    if (ownCount === 0) {
      continue;
    }

    const visited = new Set<string>([agentId]);
    let parentAgentId = parentById.get(agentId) ?? null;

    while (parentAgentId) {
      if (visited.has(parentAgentId)) {
        break;
      }
      visited.add(parentAgentId);

      counts.set(parentAgentId, (counts.get(parentAgentId) ?? 0) + ownCount);
      parentAgentId = parentById.get(parentAgentId) ?? null;
    }
  }

  return counts;
}
