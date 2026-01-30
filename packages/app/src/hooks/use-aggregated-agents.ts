import { useMemo, useCallback } from "react";
import { useShallow } from "zustand/shallow";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import type { Agent } from "@/stores/session-store";
import { isPerfLoggingEnabled } from "@/utils/perf";

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

  const sessionMethods = useSessionStore(
    useShallow((state) => {
      const result: Record<string, NonNullable<typeof state.sessions[string]["methods"]> | undefined> = {};
      for (const [serverId, session] of Object.entries(state.sessions)) {
        result[serverId] = session.methods ?? undefined;
      }
      return result;
    })
  );

  const refreshAll = useCallback(() => {
    console.log('[useAggregatedAgents] Manual refresh triggered for all sessions');
    for (const [serverId, methods] of Object.entries(sessionMethods)) {
      if (methods?.refreshSession) {
        console.log(`[useAggregatedAgents] Refreshing session ${serverId}`);
        methods.refreshSession();
      }
    }
  }, [sessionMethods]);

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
    const connectingReasons: string[] = [];
    const isConnecting = Array.from(connectionStates.entries()).some(([id, c]) => {
      const shortId = id.substring(0, 20);

      // First-time connection (never received agent list)
      if (c.status === 'connecting' && !c.hasEverReceivedAgentList) {
        connectingReasons.push(`${shortId}: first-time connecting`);
        return true;
      }
      if (c.status === 'online' && !c.hasEverReceivedAgentList) {
        connectingReasons.push(`${shortId}: online but no agent_list yet`);
        return true;
      }

      // Reconnecting (have received agent list before)
      if (c.status === 'connecting' && c.hasEverReceivedAgentList) {
        connectingReasons.push(`${shortId}: reconnecting`);
        return true;
      }
      if (c.status === 'online' && !c.agentListReady && c.hasEverReceivedAgentList) {
        connectingReasons.push(`${shortId}: online but agentListReady=false (waiting for agent_list)`);
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

    if (isPerfLoggingEnabled()) {
      const connectionStatesArray = Array.from(connectionStates.entries()).map(([id, state]) => ({
        id: id.substring(0, 20) + (id.length > 20 ? '...' : ''),
        status: state.status,
        agentListReady: state.agentListReady,
        hasEverReceivedAgentList: state.hasEverReceivedAgentList,
      }));

      console.log('[useAggregatedAgents] States:', {
        hasAnyData,
        isConnecting,
        isInitialLoad,
        isRevalidating,
        totalConnectionStates: connectionStates.size,
        connectingReasons: connectingReasons.length > 0 ? connectingReasons : 'none',
      });

      console.log('[useAggregatedAgents] Connection States Detail:',
        JSON.stringify(connectionStatesArray, null, 2)
      );
    }

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
