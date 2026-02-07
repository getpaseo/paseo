import { useMemo, useCallback } from "react";
import { useShallow } from "zustand/shallow";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import type { Agent } from "@/stores/session-store";
import { derivePendingPermissionKey, normalizeAgentSnapshot } from "@/utils/agent-snapshots";

export interface AggregatedAgent extends AgentDirectoryEntry {
  serverId: string;
  serverLabel: string;
}

export interface AggregatedAgentsResult {
  agents: AggregatedAgent[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

export function useAggregatedAgents(): AggregatedAgentsResult {
  const { connectionStates } = useDaemonConnections();

  const sessionAgents = useSessionStore(
    useShallow((state) => {
      const result: Record<string, Map<string, Agent> | undefined> = {};
      for (const [serverId, session] of Object.entries(state.sessions)) {
        result[serverId] = session.agents;
      }
      return result;
    })
  );

  const sessionClients = useSessionStore(
    useShallow((state) => {
      const result: Record<string, NonNullable<typeof state.sessions[string]["client"]> | null> = {};
      for (const [serverId, session] of Object.entries(state.sessions)) {
        result[serverId] = session.client ?? null;
      }
      return result;
    })
  );

  const refreshAll = useCallback(() => {
    for (const [serverId, client] of Object.entries(sessionClients)) {
      if (!client) {
        continue;
      }
      void (async () => {
        try {
          const agentsList = await client.fetchAgents({
            filter: { labels: { ui: "true" } },
          });

          const agents = new Map();
          const pendingPermissions = new Map();
          const agentLastActivity = new Map();

          for (const snapshot of agentsList) {
            const agent = normalizeAgentSnapshot(snapshot, serverId);
            agents.set(agent.id, agent);
            agentLastActivity.set(agent.id, agent.lastActivityAt);
            for (const request of agent.pendingPermissions) {
              const key = derivePendingPermissionKey(agent.id, request);
              pendingPermissions.set(key, { key, agentId: agent.id, request });
            }
          }

          const store = useSessionStore.getState();
          store.setAgents(serverId, agents);
          for (const [agentId, timestamp] of agentLastActivity.entries()) {
            store.setAgentLastActivity(agentId, timestamp);
          }
          store.setPendingPermissions(serverId, pendingPermissions);
        } catch (error) {
          console.warn("[useAggregatedAgents] Failed to refresh session", { serverId, error });
        }
      })();
    }
  }, [sessionClients]);

  const result = useMemo(() => {
    const allAgents: AggregatedAgent[] = [];

    // Derive agent directory from all sessions
    for (const [serverId, agents] of Object.entries(sessionAgents)) {
      if (!agents || agents.size === 0) {
        continue;
      }
      const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
      for (const agent of agents.values()) {
        const nextAgent: AggregatedAgent = {
          id: agent.id,
          serverId,
          serverLabel,
          title: agent.title ?? null,
          status: agent.status,
          lastActivityAt: agent.lastActivityAt,
          cwd: agent.cwd,
          provider: agent.provider,
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason,
          attentionTimestamp: agent.attentionTimestamp,
          archivedAt: agent.archivedAt,
          labels: agent.labels,
        };
        allAgents.push(nextAgent);
      }
    }

    // Sort by: running agents first, then by most recent activity
    allAgents.sort((left, right) => {
      const leftRunning = left.status === "running";
      const rightRunning = right.status === "running";
      if (leftRunning && !rightRunning) {
        return -1;
      }
      if (!leftRunning && rightRunning) {
        return 1;
      }
      const leftTime = left.lastActivityAt.getTime();
      const rightTime = right.lastActivityAt.getTime();
      return rightTime - leftTime;
    });

    // Check if we have any cached data
    const hasAnyData = allAgents.length > 0;

    // Check if any connection is currently loading
    const isConnecting = Array.from(connectionStates.entries()).some(([, c]) => {
      // First-time connection (never received agent list)
      if (c.status === 'connecting' && !c.hasEverReceivedAgentList) {
        return true;
      }
      if (c.status === 'online' && !c.hasEverReceivedAgentList) {
        return true;
      }

      // Reconnecting (have received agent list before)
      if (c.status === 'connecting' && c.hasEverReceivedAgentList) {
        return true;
      }
      if (c.status === 'online' && !c.agentListReady && c.hasEverReceivedAgentList) {
        return true;
      }

      return false;
    });

    // isInitialLoad: Loading for the first time (no cached data)
    const isInitialLoad = isConnecting && !hasAnyData;

    // isRevalidating: Loading but we have cached data (reconnecting)
    const isRevalidating = isConnecting && hasAnyData;

    // isLoading: Generic loading flag (either initial or revalidating)
    const isLoading = isConnecting;

    return {
      agents: allAgents,
      isLoading,
      isInitialLoad,
      isRevalidating,
    };
  }, [sessionAgents, connectionStates]);

  return {
    ...result,
    refreshAll,
  };
}
