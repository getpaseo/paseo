import type { Agent } from "@/stores/session-store";
import type { AggregatedAgent } from "@/types/aggregated-agent";

export function toAggregatedAgent(params: {
  source: Agent;
  serverId: string;
  serverLabel: string;
}): AggregatedAgent {
  const source = params.source;
  return {
    id: source.id,
    serverId: params.serverId,
    serverLabel: params.serverLabel,
    title: source.title ?? null,
    status: source.status,
    lastActivityAt: source.lastActivityAt,
    cwd: source.cwd,
    provider: source.provider,
    pendingPermissionCount: source.pendingPermissions.length,
    requiresAttention: source.requiresAttention,
    attentionReason: source.attentionReason,
    attentionTimestamp: source.attentionTimestamp ?? null,
    archivedAt: source.archivedAt ?? null,
    createdAt: source.createdAt,
    labels: source.labels,
    persistence: source.persistence ?? null,
    runtimeInfo: source.runtimeInfo,
  };
}

export function buildAllAgentsList(params: {
  agents: Iterable<Agent>;
  serverId: string;
  serverLabel: string;
  includeArchived: boolean;
}): AggregatedAgent[] {
  const list: AggregatedAgent[] = [];

  for (const agent of params.agents) {
    const aggregated = toAggregatedAgent({
      source: agent,
      serverId: params.serverId,
      serverLabel: params.serverLabel,
    });
    if (!params.includeArchived && aggregated.archivedAt) {
      continue;
    }
    list.push(aggregated);
  }

  list.sort((left, right) => {
    const leftRunning = left.status === "running";
    const rightRunning = right.status === "running";
    if (leftRunning && !rightRunning) {
      return -1;
    }
    if (!leftRunning && rightRunning) {
      return 1;
    }
    return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
  });

  return list;
}
