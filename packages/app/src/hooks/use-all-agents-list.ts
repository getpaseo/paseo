import { useCallback, useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatus,
  useHostRuntimeIsDirectoryLoading,
} from "@/runtime/host-runtime";
import { useActiveOrgId } from "@/stores/active-org-store";
import type { AggregatedAgent, AggregatedAgentsResult } from "@/hooks/use-aggregated-agents";

function toAggregatedAgent(params: {
  source: Agent;
  serverId: string;
  serverLabel: string;
  isGlobal?: boolean;
}): AggregatedAgent {
  const source = params.source;
  return {
    id: source.id,
    serverId: params.serverId,
    serverLabel: params.serverLabel,
    title: source.title ?? null,
    status: source.status,
    lastActivityAt: source.lastActivityAt,
    cwd: source.cwd,
    provider: source.provider,
    pendingPermissionCount: source.pendingPermissions.length,
    requiresAttention: source.requiresAttention,
    attentionReason: source.attentionReason,
    attentionTimestamp: source.attentionTimestamp ?? null,
    archivedAt: source.archivedAt ?? null,
    createdAt: source.createdAt,
    labels: source.labels,
    ...(params.isGlobal ? { isGlobal: true } : {}),
  };
}

function buildAllAgentsList(params: {
  agents: Iterable<Agent>;
  serverId: string;
  serverLabel: string;
  includeArchived: boolean;
  workspaces?: Map<string, WorkspaceDescriptor> | null;
  activeOrgId?: string | null;
}): AggregatedAgent[] {
  const list: AggregatedAgent[] = [];

  for (const agent of params.agents) {
    if (!params.includeArchived && agent.archivedAt) {
      continue;
    }
    // Decide whether the agent's cwd belongs to the active org. Agents whose
    // workspace is missing from the org-scoped workspace map (or registered
    // under a different org) used to be hidden, which made cross-org or
    // unregistered cwds disappear after auth/org switches even though their
    // history was on disk. Now we surface them with `isGlobal: true` so the
    // UI can render a tag, and the user can see/open them.
    let isGlobal = false;
    if (params.activeOrgId && params.workspaces) {
      const workspace = params.workspaces.get(agent.cwd);
      if (!workspace || workspace.orgId !== params.activeOrgId) {
        isGlobal = true;
      }
    }
    list.push(
      toAggregatedAgent({
        source: agent,
        serverId: params.serverId,
        serverLabel: params.serverLabel,
        isGlobal,
      }),
    );
  }

  list.sort((left, right) => {
    const leftRunning = left.status === "running";
    const rightRunning = right.status === "running";
    if (leftRunning && !rightRunning) {
      return -1;
    }
    if (!leftRunning && rightRunning) {
      return 1;
    }
    return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
  });

  return list;
}

export function useAllAgentsList(options?: {
  serverId?: string | null;
  includeArchived?: boolean;
}): AggregatedAgentsResult {
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();

  const serverId = useMemo(() => {
    const value = options?.serverId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }, [options?.serverId]);
  const includeArchived = options?.includeArchived ?? false;

  const liveAgents = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.agents ?? null) : null,
  );
  const sessionWorkspaces = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.workspaces ?? null) : null,
  );
  const activeOrgId = useActiveOrgId();
  const connectionStatus = useHostRuntimeConnectionStatus(serverId ?? "");

  const refreshAll = useCallback(() => {
    if (!serverId || connectionStatus !== "online") {
      return;
    }
    void runtime.refreshAgentDirectory({ serverId }).catch(() => undefined);
  }, [runtime, serverId, connectionStatus]);

  const agents = useMemo(() => {
    if (!serverId || !liveAgents) {
      return [];
    }
    const serverLabel = daemons.find((daemon) => daemon.serverId === serverId)?.label ?? serverId;
    return buildAllAgentsList({
      agents: liveAgents.values(),
      serverId,
      serverLabel,
      includeArchived,
      workspaces: sessionWorkspaces,
      activeOrgId,
    });
  }, [daemons, includeArchived, liveAgents, serverId, sessionWorkspaces, activeOrgId]);

  const isDirectoryLoading = useHostRuntimeIsDirectoryLoading(serverId ?? "");
  const isInitialLoad = isDirectoryLoading && agents.length === 0;
  const isRevalidating = isDirectoryLoading && agents.length > 0;

  return {
    agents,
    isLoading: isDirectoryLoading,
    isInitialLoad,
    isRevalidating,
    refreshAll,
  };
}

export const __private__ = {
  buildAllAgentsList,
  toAggregatedAgent,
};
