import { useMemo, useCallback, useSyncExternalStore } from "react";
import { shallow, useShallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore } from "@/stores/session-store";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import type { Agent } from "@/stores/session-store";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";

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

export type AggregatedAgentSortOption = "createdAt-desc-stable" | "running-then-activity";

export interface AggregatedAgentIdEntry {
  id: string;
  serverId: string;
  status: Agent["status"];
  lastActivityAt: Date;
  cwd: string;
  archivedAt: Date | null;
  createdAt: Date;
}

interface AggregatedAgentSortFields {
  id: string;
  status: Agent["status"];
  lastActivityAt: Date;
  createdAt: Date;
}

function compareAggregatedAgentsByCreatedAtDescStable(
  left: AggregatedAgentSortFields,
  right: AggregatedAgentSortFields,
): number {
  const createdAtDiff = right.createdAt.getTime() - left.createdAt.getTime();
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }
  return left.id.localeCompare(right.id);
}

function compareAggregatedAgentsByRunningThenActivity(
  left: AggregatedAgentSortFields,
  right: AggregatedAgentSortFields,
): number {
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
}

function sortAggregatedAgents(
  agents: AggregatedAgent[],
  sort: AggregatedAgentSortOption,
): AggregatedAgent[] {
  agents.sort(
    sort === "running-then-activity"
      ? compareAggregatedAgentsByRunningThenActivity
      : compareAggregatedAgentsByCreatedAtDescStable,
  );
  return agents;
}

function sortAggregatedAgentIdEntries(
  agents: AggregatedAgentIdEntry[],
  sort: AggregatedAgentSortOption,
): AggregatedAgentIdEntry[] {
  agents.sort(
    sort === "running-then-activity"
      ? compareAggregatedAgentsByRunningThenActivity
      : compareAggregatedAgentsByCreatedAtDescStable,
  );
  return agents;
}

export function useAggregatedAgentIds(options?: {
  includeArchived?: boolean;
  sort?: AggregatedAgentSortOption;
  filter?: (agent: AggregatedAgentIdEntry) => boolean;
}): string[] {
  const includeArchived = options?.includeArchived ?? false;
  const sort = options?.sort ?? "createdAt-desc-stable";
  const filter = options?.filter;

  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const agents: AggregatedAgentIdEntry[] = [];
      for (const [serverId, session] of Object.entries(state.sessions)) {
        for (const agent of session.agents.values()) {
          if (!includeArchived && agent.archivedAt) {
            continue;
          }
          const entry: AggregatedAgentIdEntry = {
            id: agent.id,
            serverId,
            status: agent.status,
            lastActivityAt: agent.lastActivityAt,
            cwd: agent.cwd,
            archivedAt: agent.archivedAt ?? null,
            createdAt: agent.createdAt,
          };
          if (!filter || filter(entry)) {
            agents.push(entry);
          }
        }
      }
      return sortAggregatedAgentIdEntries(agents, sort).map((agent) => agent.id);
    },
    shallow,
  );
}

export function useAggregatedAgentsInitialLoad(): boolean {
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const agentCount = useSessionStore((state) => {
    let count = 0;
    for (const session of Object.values(state.sessions)) {
      for (const agent of session.agents.values()) {
        if (!agent.archivedAt) {
          count += 1;
        }
      }
    }
    return count;
  });

  void runtimeVersion;
  const isLoading = daemons.some((daemon) => {
    const status = runtime.getSnapshot(daemon.serverId)?.agentDirectoryStatus ?? "initial_loading";
    return status === "initial_loading" || status === "revalidating";
  });
  return isLoading && agentCount === 0;
}

export function useAggregatedAgents(options?: {
  includeArchived?: boolean;
  sort?: AggregatedAgentSortOption;
}): AggregatedAgentsResult {
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();
  const includeArchived = options?.includeArchived ?? false;
  const sort = options?.sort ?? "createdAt-desc-stable";
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
    // runtimeVersion is referenced so the memo recomputes when runtime state changes.
    void runtimeVersion;
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
          id: agent.id,
          serverId,
          serverLabel,
          title: agent.title ?? null,
          status: agent.status,
          lastActivityAt: agent.lastActivityAt,
          cwd: agent.cwd,
          provider: agent.provider,
          pendingPermissionCount: agent.pendingPermissions.length,
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason,
          attentionTimestamp: agent.attentionTimestamp,
          archivedAt: agent.archivedAt,
          createdAt: agent.createdAt,
          labels: agent.labels,
        };
        allAgents.push(nextAgent);
      }
    }

    sortAggregatedAgents(allAgents, sort);

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
  }, [daemons, includeArchived, runtime, runtimeVersion, sessionAgents, sort]);

  return {
    ...result,
    refreshAll,
  };
}
