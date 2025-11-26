import { useMemo } from "react";
import type { Agent } from "@/contexts/session-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionDirectory } from "@/hooks/use-session-directory";

export interface AggregatedAgentGroup {
  serverId: string;
  serverLabel: string;
  agents: Agent[];
}

export interface AggregatedAgentsResult {
  groups: AggregatedAgentGroup[];
  isLoading: boolean;
}

const sortAgents = (agents: Agent[]): Agent[] => {
  return [...agents].sort((left, right) => {
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
};

export function useAggregatedAgents(): AggregatedAgentsResult {
  const { connectionStates, isLoading: registryLoading } = useDaemonConnections();
  const sessionDirectory = useSessionDirectory();

  return useMemo(() => {
    const groups = new Map<string, { serverLabel: string; agents: Agent[] }>();
    const daemonOrder = new Map<string, number>();
    Array.from(connectionStates.keys()).forEach((serverId, index) => {
      daemonOrder.set(serverId, index);
    });

    if (sessionDirectory.size > 0) {
      sessionDirectory.forEach((session, serverId) => {
        if (!session) {
          return;
        }
        const label = connectionStates.get(serverId)?.daemon.label ?? serverId;
        const sessionAgents = Array.from(session.agents.values());
        if (sessionAgents.length === 0) {
          return;
        }
        const existing = groups.get(serverId);
        if (existing) {
          existing.agents.push(...sessionAgents);
        } else {
          groups.set(serverId, { serverLabel: label, agents: sessionAgents });
        }
      });
    }

    const aggregatedGroups = Array.from(groups.entries()).map(([serverId, { serverLabel, agents }]) => ({
      serverId,
      serverLabel,
      agents: sortAgents(agents),
    }));

    aggregatedGroups.sort((left, right) => {
      const leftIndex = daemonOrder.get(left.serverId);
      const rightIndex = daemonOrder.get(right.serverId);
      if (leftIndex !== undefined && rightIndex !== undefined && leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      if (leftIndex !== undefined) {
        return -1;
      }
      if (rightIndex !== undefined) {
        return 1;
      }
      return left.serverLabel.localeCompare(right.serverLabel);
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

    return { groups: aggregatedGroups, isLoading };
  }, [sessionDirectory, connectionStates, registryLoading]);
}
