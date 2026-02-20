import { useMemo, useCallback } from "react";
import { useShallow } from "zustand/shallow";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import type { Agent } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

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
  const runtime = getHostRuntimeStore();

  const sessionAgents = useSessionStore(
    useShallow((state) => {
      const result: Record<string, Map<string, Agent> | undefined> = {};
      for (const [serverId, session] of Object.entries(state.sessions)) {
        result[serverId] = session.agents;
      }
      return result;
    })
  );

  const refreshAll = useCallback(() => {
    runtime.refreshAllAgentDirectories();
  }, [runtime]);

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

    // Align list loading with the runtime directory-sync machine.
    const isLoading = Array.from(connectionStates.values()).some(
      (connection) =>
        connection.agentDirectoryStatus === "initial_loading" ||
        connection.agentDirectoryStatus === "revalidating"
    );
    const isInitialLoad = isLoading && !hasAnyData;
    const isRevalidating = isLoading && hasAnyData;

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
