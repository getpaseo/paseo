import { useMemo } from "react";
import type { Agent } from "@/contexts/session-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";

export interface AggregatedAgent extends Agent {
  serverId: string;
  serverLabel: string;
}

export interface AggregatedAgentsResult {
  agents: AggregatedAgent[];
  isLoading: boolean;
}

export function useAggregatedAgents(): AggregatedAgentsResult {
  const { connectionStates, sessionSnapshots } = useDaemonConnections();

  return useMemo(() => {
    const allAgents: AggregatedAgent[] = [];

    for (const [serverId, snapshot] of sessionSnapshots) {
      if (snapshot.agents.size === 0) {
        continue;
      }
      const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
      for (const agent of snapshot.agents.values()) {
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
      const leftTime = (left.lastUserMessageAt ?? left.lastActivityAt).getTime();
      const rightTime = (right.lastUserMessageAt ?? right.lastActivityAt).getTime();
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

    console.log("[useAggregatedAgents] aggregated agent count:", allAgents.length, "isLoading:", isLoading);
    return { agents: allAgents, isLoading };
  }, [sessionSnapshots, connectionStates]);
}
