import { useMemo } from "react";
import type { Agent } from "@/contexts/session-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionDirectory } from "@/hooks/use-session-directory";

export interface AggregatedAgent extends Agent {
  serverId: string;
  serverLabel: string;
}

export interface AggregatedAgentsResult {
  agents: AggregatedAgent[];
  isLoading: boolean;
}

export function useAggregatedAgents(): AggregatedAgentsResult {
  const { connectionStates, isLoading: registryLoading } = useDaemonConnections();
  const sessionDirectory = useSessionDirectory();

  return useMemo(() => {
    const allAgents: AggregatedAgent[] = [];

    sessionDirectory.forEach((session, serverId) => {
      if (!session) {
        return;
      }
      const serverLabel = connectionStates.get(serverId)?.daemon.label ?? serverId;
      for (const agent of session.agents.values()) {
        allAgents.push({
          ...agent,
          serverId,
          serverLabel,
        });
      }
    });

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

    // Loading if registry is still loading, or if any host is connecting and hasn't
    // reported agents yet (idle hosts that haven't connected don't block loading)
    let isLoading = registryLoading;
    if (!isLoading && connectionStates.size > 0) {
      for (const [serverId, record] of connectionStates) {
        const hasSession = sessionDirectory.has(serverId);
        if (record.status === "connecting" && !hasSession) {
          isLoading = true;
          break;
        }
      }
    }

    return { agents: allAgents, isLoading };
  }, [sessionDirectory, connectionStates, registryLoading]);
}
