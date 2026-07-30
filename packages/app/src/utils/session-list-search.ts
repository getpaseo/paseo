import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { matchesAnySearchText } from "@/utils/list-text-search";

export function filterAgentsBySearchQuery<T extends AggregatedAgent>(
  agents: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim();
  if (!normalized) {
    return [...agents];
  }
  return agents.filter((agent) =>
    matchesAnySearchText(
      [agent.title, agent.provider, agent.cwd, agent.serverLabel, agent.status, agent.workspaceId],
      normalized,
    ),
  );
}
