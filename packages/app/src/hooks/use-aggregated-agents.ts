import { useMemo } from "react";
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
}

export function useAggregatedAgents(): AggregatedAgentsResult {
  const { connectionStates } = useDaemonConnections();
  const agentDirectory = useSessionStore((state) => state.agentDirectory);

  return useMemo(() => {
    const allAgents: AggregatedAgent[] = [];

    for (const [serverId, agents] of Object.entries(agentDirectory)) {
      if (!agents || agents.length === 0) {
        continue;
      }
      const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
      for (const agent of agents) {
        allAgents.push({
          ...agent,
          serverId,
          serverLabel,
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

    const isLoading = Array.from(connectionStates.values()).some(c => {
      // Only these states count as "loading":
      // 1. Actively connecting
      // 2. Online but session not yet received
      if (c.status === 'connecting') return true;
      if (c.status === 'online' && !c.sessionReady) return true;

      // Offline/error = not loading, just unavailable (normal state)
      return false;
    });

    return { agents: allAgents, isLoading };
  }, [agentDirectory, connectionStates]);
}
