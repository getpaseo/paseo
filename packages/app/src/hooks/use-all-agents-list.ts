import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { AggregatedAgent, AggregatedAgentsResult } from "@/hooks/use-aggregated-agents";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";

const ALL_AGENTS_STALE_TIME = 60_000;

function toAggregatedAgent(params: {
  source: Agent | ReturnType<typeof normalizeAgentSnapshot>;
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
  const queryClient = useQueryClient();
  const serverId = useMemo(() => {
    const value = options?.serverId;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }, [options?.serverId]);

  const session = useSessionStore((state) =>
    serverId ? state.sessions[serverId] : undefined
  );
  const client = session?.client ?? null;
  const isConnected = session?.connection.isConnected ?? false;
  const liveAgents = session?.agents ?? null;
  const canFetch = Boolean(serverId && client && isConnected);

  const agentsQuery = useQuery({
    queryKey: ["allAgents", serverId] as const,
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      return await client.fetchAgents({
        filter: { labels: { ui: "true" } },
      });
    },
    enabled: canFetch,
    staleTime: ALL_AGENTS_STALE_TIME,
    refetchOnMount: "always" as const,
  });

  const refreshAll = useCallback(() => {
    if (!serverId) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: ["allAgents", serverId],
    });
  }, [queryClient, serverId]);

  const agents = useMemo(() => {
    if (!serverId) {
      return [];
    }
    const data = agentsQuery.data?.entries ?? [];
    const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
    const list: AggregatedAgent[] = [];

    for (const entry of data) {
      const snapshot = entry.agent;
      const normalized = normalizeAgentSnapshot(snapshot, serverId);
      const live = liveAgents?.get(snapshot.id);
      const aggregated = toAggregatedAgent({
        source: live ?? normalized,
        serverId,
        serverLabel,
      });
      if (aggregated.archivedAt) {
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
  }, [agentsQuery.data, connectionStates, liveAgents, serverId]);

  const isFetching =
    canFetch && (agentsQuery.isPending || agentsQuery.isFetching);
  const isInitialLoad = isFetching && agents.length === 0;
  const isRevalidating = isFetching && agents.length > 0;

  return {
    agents,
    isLoading: isFetching,
    isInitialLoad,
    isRevalidating,
    refreshAll,
  };
}
