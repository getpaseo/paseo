import { useMemo, useCallback } from "react";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";

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
  const sessions = useSessionStore((state) => state.sessions);

  const refreshAll = useCallback(() => {
    console.log('[useAggregatedAgents] Manual refresh triggered for all sessions');
    for (const [serverId, session] of Object.entries(sessions)) {
      if (session?.methods?.refreshSession) {
        console.log(`[useAggregatedAgents] Refreshing session ${serverId}`);
        session.methods.refreshSession();
      }
    }
  }, [sessions]);

  const result = useMemo(() => {
    const allAgents: AggregatedAgent[] = [];

    // Derive agent directory from all sessions
    for (const [serverId, session] of Object.entries(sessions)) {
      if (!session?.agents || session.agents.size === 0) {
        continue;
      }
      const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
      for (const agent of session.agents.values()) {
        // Use agent's own lastActivityAt field directly
        allAgents.push({
          id: agent.id,
          serverId,
          serverLabel,
          title: agent.title ?? null,
          status: agent.status,
          lastActivityAt: agent.lastActivityAt,
          cwd: agent.cwd,
          provider: agent.provider,
        });
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

      // First-time connection (never received session state)
      if (c.status === 'connecting' && !c.hasEverReceivedSessionState) {
        connectingReasons.push(`${shortId}: first-time connecting`);
        return true;
      }
      if (c.status === 'online' && !c.hasEverReceivedSessionState) {
        connectingReasons.push(`${shortId}: online but no session_state yet`);
        return true;
      }

      // Reconnecting (have received session state before)
      if (c.status === 'connecting' && c.hasEverReceivedSessionState) {
        connectingReasons.push(`${shortId}: reconnecting`);
        return true;
      }
      if (c.status === 'online' && !c.sessionReady && c.hasEverReceivedSessionState) {
        connectingReasons.push(`${shortId}: online but sessionReady=false (waiting for session_state)`);
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

    const connectionStatesArray = Array.from(connectionStates.entries()).map(([id, state]) => ({
      id: id.substring(0, 20) + (id.length > 20 ? '...' : ''),
      status: state.status,
      sessionReady: state.sessionReady,
      hasEverReceivedSessionState: state.hasEverReceivedSessionState,
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

    return {
      agents: allAgents,
      isLoading,
      isInitialLoad,
      isRevalidating,
    };
  }, [sessions, connectionStates]);

  return {
    ...result,
    refreshAll,
  };
}
