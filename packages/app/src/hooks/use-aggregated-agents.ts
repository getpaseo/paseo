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
  const sessions = useSessionStore((state) => state.sessions);

  return useMemo(() => {
    const allAgents: AggregatedAgent[] = [];

    // Derive agent directory from all sessions
    for (const [serverId, session] of Object.entries(sessions)) {
      if (!session?.agents || session.agents.size === 0) {
        continue;
      }
      const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
      for (const agent of session.agents.values()) {
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
  }, [sessions, connectionStates]);
}
