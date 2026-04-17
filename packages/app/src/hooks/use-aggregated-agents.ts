import { useMemo, useCallback, useSyncExternalStore } from "react";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import type { Agent } from "@/stores/session-store";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import type { AggregatedAgent } from "@/types/aggregated-agent";
import { toAggregatedAgent } from "@/utils/aggregated-agent";

export type { AggregatedAgent } from "@/types/aggregated-agent";

export interface AggregatedAgentsResult {
  agents: AggregatedAgent[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

export function useAggregatedAgents(options?: {
  includeArchived?: boolean;
}): AggregatedAgentsResult {
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();
  const includeArchived = options?.includeArchived ?? false;
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );

  const sessionAgents = useSessionStore(
    useShallow((state) => {
      const result: Record<string, Map<string, Agent> | undefined> = {};
      for (const [serverId, session] of Object.entries(state.sessions)) {
        result[serverId] = session.agents;
      }
      return result;
    }),
  );

  const refreshAll = useCallback(() => {
    runtime.refreshAllAgentDirectories();
  }, [runtime]);

  const result = useMemo(() => {
    const allAgents: AggregatedAgent[] = [];
    const serverLabelById = new Map(
      daemons.map((daemon) => [daemon.serverId, daemon.label] as const),
    );

    // Derive agent directory from all sessions
    for (const [serverId, agents] of Object.entries(sessionAgents)) {
      if (!agents || agents.size === 0) {
        continue;
      }
      const serverLabel = serverLabelById.get(serverId) ?? serverId;
      for (const agent of agents.values()) {
        if (!includeArchived && agent.archivedAt) {
          continue;
        }
        const nextAgent: AggregatedAgent = {
          ...toAggregatedAgent({
            source: agent,
            serverId,
            serverLabel,
          }),
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
    const isLoading = daemons.some((daemon) => {
      const status =
        runtime.getSnapshot(daemon.serverId)?.agentDirectoryStatus ?? "initial_loading";
      return status === "initial_loading" || status === "revalidating";
    });
    const isInitialLoad = isLoading && !hasAnyData;
    const isRevalidating = isLoading && hasAnyData;

    return {
      agents: allAgents,
      isLoading,
      isInitialLoad,
      isRevalidating,
    };
  }, [daemons, includeArchived, runtime, runtimeVersion, sessionAgents]);

  return {
    ...result,
    refreshAll,
  };
}
