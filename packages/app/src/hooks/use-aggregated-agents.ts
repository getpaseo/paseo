import { useMemo, useCallback, useEffect, useRef } from "react";
import equal from "fast-deep-equal";
import { useAgentDirectories } from "@/stores/session-store-hooks";
import type { Agent } from "@/stores/session-store-hooks";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import {
  acquireDirectoryDemand,
  readHostRuntimeSnapshot,
  refreshHostDirectories,
  useHostRuntimeVersion,
  useHosts,
} from "@/runtime/host-runtime";

export interface AggregatedAgent extends AgentDirectoryEntry {
  serverId: string;
  serverLabel: string;
}

interface AgentSource {
  serverId: string;
  agents: ReadonlyMap<string, Agent>;
}

const EMPTY_AGENT_MAP: ReadonlyMap<string, Agent> = new Map();

function agentSourcesEqual(left: AgentSource[], right: AgentSource[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (source, index) =>
        source.serverId === right[index]?.serverId && source.agents === right[index]?.agents,
    )
  );
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
  demand?: boolean;
}): AggregatedAgentsResult {
  const daemons = useHosts();
  const includeArchived = options?.includeArchived ?? false;
  const demand = options?.demand ?? true;
  const serverIds = useMemo(() => daemons.map((daemon) => daemon.serverId), [daemons]);
  useEffect(() => {
    if (!demand) return;
    const releases = serverIds.map(acquireDirectoryDemand);
    return () => releases.forEach((release) => release());
  }, [demand, serverIds]);
  const runtimeVersion = useHostRuntimeVersion();

  const sessionAgents = useAgentDirectories(
    serverIds,
    (directories) =>
      serverIds.map((serverId) => ({
        serverId,
        agents: directories.get(serverId)?.agents ?? EMPTY_AGENT_MAP,
      })),
    agentSourcesEqual,
  );

  const refreshAll = useCallback(() => {
    if (!demand) return;
    for (const serverId of serverIds) void refreshHostDirectories(serverId);
  }, [demand, serverIds]);

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
    for (const { serverId, agents } of sessionAgents) {
      if (agents.size === 0) {
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
          turn: agent.turn,
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
          projectPlacement: agent.projectPlacement,
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
      const leftRunning = left.turn.phase === "open";
      const rightRunning = right.turn.phase === "open";
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
        readHostRuntimeSnapshot(daemon.serverId)?.agentDirectoryStatus ?? "initial_loading";
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
  }, [daemons, includeArchived, runtimeVersion, sessionAgents]);

  return {
    ...result,
    refreshAll,
  };
}
