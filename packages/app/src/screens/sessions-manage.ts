import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  pruneSelectedAgentKeys,
  selectAllArchivedAgentKeys,
  toAgentListKey,
} from "@/components/agent-list-selection";

export function toggleAgentSelectionKey(
  selectedKeys: ReadonlySet<string>,
  agent: AggregatedAgent,
): Set<string> {
  const key = toAgentListKey(agent);
  const next = new Set(selectedKeys);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

export function resolveSelectedArchivedAgents(
  agents: readonly AggregatedAgent[],
  selectedKeys: ReadonlySet<string>,
): AggregatedAgent[] {
  return agents.filter((agent) => selectedKeys.has(toAgentListKey(agent)));
}

export function areAllArchivedAgentsSelected(
  agents: readonly AggregatedAgent[],
  selectedKeys: ReadonlySet<string>,
): boolean {
  const archivedKeys = selectAllArchivedAgentKeys(agents);
  if (archivedKeys.size === 0) {
    return false;
  }
  for (const key of archivedKeys) {
    if (!selectedKeys.has(key)) {
      return false;
    }
  }
  return true;
}

export function syncSelectedKeysToAgents(
  selectedKeys: ReadonlySet<string>,
  agents: readonly AggregatedAgent[],
): Set<string> {
  return pruneSelectedAgentKeys(selectedKeys, agents);
}

export async function deleteSelectedArchivedAgents(input: {
  agents: readonly AggregatedAgent[];
  selectedKeys: ReadonlySet<string>;
  deleteAgent: (input: { serverId: string; agentId: string }) => Promise<void>;
}): Promise<number> {
  const targets = resolveSelectedArchivedAgents(input.agents, input.selectedKeys);
  await Promise.all(
    targets.map(async (agent) => {
      try {
        await input.deleteAgent({ serverId: agent.serverId, agentId: agent.id });
      } catch {
        // Keep deleting the rest; UI refreshes from invalidation + agent_deleted.
      }
    }),
  );
  return targets.length;
}
