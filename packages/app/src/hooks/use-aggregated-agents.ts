import { useMemo, useCallback, useRef, useSyncExternalStore } from "react";
import equal from "fast-deep-equal";
import { useShallow } from "zustand/shallow";
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

  // Keyed by "serverId:agentId" — reuse the previous AggregatedAgent object when
  // none of its fields changed, so downstream memo/shallow comparisons can bail early.
  const prevAgentsRef = useRef<Map<string, AggregatedAgent>>(new Map());
  // Preserved sorted array — returned as-is when every element kept its identity
  // and order, so callers using reference equality skip re-renders entirely.
  const prevSortedRef = useRef<AggregatedAgent[]>([]);

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
          workspaceId: agent.workspaceId,
          provider: agent.provider,
          pendingPermissionCount: agent.pendingPermissions.length,
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason,
          attentionTimestamp: agent.attentionTimestamp,
          archivedAt: agent.archivedAt,
          createdAt: agent.createdAt,
          labels: agent.labels,
        };
        const cacheKey = `${serverId}:${agent.id}`;
        const prev = prevAgentsRef.current.get(cacheKey);
        // Preserve object identity when fields are unchanged so callers can use
        // reference equality (useShallow, memo) to skip re-renders.
        allAgents.push(prev !== undefined && equal(prev, nextAgent) ? prev : nextAgent);
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

    // Update the identity cache for the next render pass.
    const nextCache = new Map<string, AggregatedAgent>();
    for (const agent of allAgents) {
      nextCache.set(`${agent.serverId}:${agent.id}`, agent);
    }
    prevAgentsRef.current = nextCache;

    // If every element kept its reference identity and the order is the same,
    // return the previous array so downstream reference comparisons can bail.
    const prevSorted = prevSortedRef.current;
    const stableAgents =
      allAgents.length === prevSorted.length &&
      allAgents.every((agent, i) => agent === prevSorted[i])
        ? prevSorted
        : allAgents;
    prevSortedRef.current = stableAgents;

    // Check if we have any cached data
    const hasAnyData = stableAgents.length > 0;

    // Align list loading with the runtime directory-sync machine.
    const isLoading = daemons.some((daemon) => {
      const status =
        runtime.getSnapshot(daemon.serverId)?.agentDirectoryStatus ?? "initial_loading";
      return status === "initial_loading" || status === "revalidating";
    });
    const isInitialLoad = isLoading && !hasAnyData;
    const isRevalidating = isLoading && hasAnyData;

    return {
      agents: stableAgents,
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
