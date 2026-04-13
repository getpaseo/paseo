import { useCallback, useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatus,
  useHostRuntimeIsDirectoryLoading,
} from "@/runtime/host-runtime";
import type { AggregatedAgent, AggregatedAgentsResult } from "@/hooks/use-aggregated-agents";

function toAggregatedAgent(params: {
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
  };
}

function buildAllAgentsList(params: {
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

export function useAllAgentsList(options?: {
  serverId?: string | null;
  includeArchived?: boolean;
}): AggregatedAgentsResult {
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();

  const serverId = useMemo(() => {
    const value = options?.serverId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }, [options?.serverId]);
  const includeArchived = options?.includeArchived ?? false;

  const liveAgents = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.agents ?? null) : null,
  );
  const connectionStatus = useHostRuntimeConnectionStatus(serverId ?? "");

  const refreshAll = useCallback(() => {
    if (!serverId || connectionStatus !== "online") {
      return;
    }
    void runtime
      .refreshAgentDirectory({
        serverId,
        filter: { includeArchived },
        loadAllPages: includeArchived,
      })
      .catch(() => undefined);
  }, [runtime, serverId, connectionStatus, includeArchived]);

  const agents = useMemo(() => {
    if (!serverId || !liveAgents) {
      return [];
    }
    const serverLabel = daemons.find((daemon) => daemon.serverId === serverId)?.label ?? serverId;
    return buildAllAgentsList({
      agents: liveAgents.values(),
      serverId,
      serverLabel,
      includeArchived,
    });
  }, [daemons, includeArchived, liveAgents, serverId]);

  const isDirectoryLoading = useHostRuntimeIsDirectoryLoading(serverId ?? "");
  const isInitialLoad = isDirectoryLoading && agents.length === 0;
  const isRevalidating = isDirectoryLoading && agents.length > 0;

  return {
    agents,
    isLoading: isDirectoryLoading,
    isInitialLoad,
    isRevalidating,
    refreshAll,
  };
}

export const __private__ = {
  buildAllAgentsList,
  toAggregatedAgent,
};
