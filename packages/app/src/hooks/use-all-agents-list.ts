import { useCallback, useMemo } from "react";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  getHostRuntimeStore,
  isHostRuntimeDirectoryLoading,
  useHostRuntimeSession,
} from "@/runtime/host-runtime";
import type {
  AggregatedAgent,
  AggregatedAgentsResult,
} from "@/hooks/use-aggregated-agents";

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
    requiresAttention: source.requiresAttention,
    attentionReason: source.attentionReason,
    attentionTimestamp: source.attentionTimestamp ?? null,
    archivedAt: source.archivedAt ?? null,
    labels: source.labels,
  };
}

export function useAllAgentsList(options?: {
  serverId?: string | null;
}): AggregatedAgentsResult {
  const { connectionStates } = useDaemonConnections();
  const runtime = getHostRuntimeStore();

  const serverId = useMemo(() => {
    const value = options?.serverId;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }, [options?.serverId]);

  const session = useSessionStore((state) =>
    serverId ? state.sessions[serverId] : undefined
  );
  const liveAgents = session?.agents ?? null;
  const { snapshot } = useHostRuntimeSession(serverId ?? "");

  const refreshAll = useCallback(() => {
    if (!serverId || snapshot?.connectionStatus !== "online") {
      return;
    }
    void runtime.refreshAgentDirectory({ serverId }).catch(() => undefined);
  }, [runtime, serverId, snapshot?.connectionStatus]);

  const agents = useMemo(() => {
    if (!serverId || !liveAgents) {
      return [];
    }
    const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
    const list: AggregatedAgent[] = [];

    for (const agent of liveAgents.values()) {
      const aggregated = toAggregatedAgent({
        source: agent,
        serverId,
        serverLabel,
      });
      if (aggregated.archivedAt) {
        continue;
      }
      if (aggregated.labels.ui !== "true") {
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
  }, [connectionStates, liveAgents, serverId]);

  const isDirectoryLoading = Boolean(serverId && isHostRuntimeDirectoryLoading(snapshot));
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
