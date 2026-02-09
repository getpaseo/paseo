import { useCallback, useMemo } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
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

export function useAllAgentsList(): AggregatedAgentsResult {
  const { connectionStates } = useDaemonConnections();
  const queryClient = useQueryClient();

  const sessionClients = useSessionStore(
    useShallow((state) => {
      const result: Record<
        string,
        NonNullable<typeof state.sessions[string]["client"]> | null
      > = {};
      for (const [serverId, session] of Object.entries(state.sessions)) {
        result[serverId] = session.client ?? null;
      }
      return result;
    })
  );

  const sessionConnections = useSessionStore(
    useShallow((state) => {
      const result: Record<string, boolean> = {};
      for (const [serverId, session] of Object.entries(state.sessions)) {
        result[serverId] = session.connection.isConnected;
      }
      return result;
    })
  );

  const liveAgents = useSessionStore(
    useShallow((state) => {
      const result: Record<string, Map<string, Agent> | undefined> = {};
      for (const [serverId, session] of Object.entries(state.sessions)) {
        result[serverId] = session.agents;
      }
      return result;
    })
  );

  const serverEntries = useMemo(
    () =>
      Object.keys(sessionClients).map((serverId) => ({
        serverId,
        client: sessionClients[serverId] ?? null,
        isConnected: sessionConnections[serverId] ?? false,
      })),
    [sessionClients, sessionConnections]
  );

  const queries = useQueries({
    queries: serverEntries.map(({ serverId, client, isConnected }) => ({
      queryKey: ["allAgents", serverId] as const,
      queryFn: async () => {
        if (!client) {
          throw new Error("Daemon client not available");
        }
        return await client.fetchAgents();
      },
      enabled: Boolean(client) && isConnected,
      staleTime: ALL_AGENTS_STALE_TIME,
      refetchOnMount: "always" as const,
    })),
  });

  const refreshAll = useCallback(() => {
    for (const { serverId } of serverEntries) {
      void queryClient.invalidateQueries({
        queryKey: ["allAgents", serverId],
      });
    }
  }, [queryClient, serverEntries]);

  const agents = useMemo(() => {
    const all: AggregatedAgent[] = [];

    for (let idx = 0; idx < serverEntries.length; idx++) {
      const entry = serverEntries[idx];
      if (!entry) {
        continue;
      }
      const data = queries[idx]?.data;
      if (!data) {
        continue;
      }
      const serverLabel =
        connectionStates.get(entry.serverId)?.daemon.label ?? entry.serverId;
      const liveById = liveAgents[entry.serverId];

      for (const snapshot of data) {
        const normalized = normalizeAgentSnapshot(snapshot, entry.serverId);
        const live = liveById?.get(snapshot.id);
        all.push(
          toAggregatedAgent({
            source: live ?? normalized,
            serverId: entry.serverId,
            serverLabel,
          })
        );
      }
    }

    all.sort((left, right) => {
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

    return all;
  }, [serverEntries, queries, connectionStates, liveAgents]);

  const isFetching = queries.some((query) => query.isPending || query.isFetching);
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
