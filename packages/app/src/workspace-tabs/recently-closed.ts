import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

export const RECENTLY_CLOSED_AGENT_LIMIT = 20;

export function selectRecentlyClosedAgents(
  agents: readonly AggregatedAgent[],
  input: { workspaceId: string; limit: number },
): AggregatedAgent[] {
  return agents
    .filter(
      (agent): agent is AggregatedAgent & { archivedAt: Date } =>
        agent.archivedAt != null && agent.workspaceId === input.workspaceId,
    )
    .sort((left, right) => right.archivedAt.getTime() - left.archivedAt.getTime())
    .slice(0, input.limit);
}
