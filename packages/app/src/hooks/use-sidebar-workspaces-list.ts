import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useCreateFlowStore, type PendingCreateAttempt } from "@/stores/create-flow-store";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { selectWorkspace, workspaceEqualityFns } from "@/stores/session-store-hooks/selectors";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";
import { selectPrHintFromStatus } from "@/git/use-pr-status-query";
import { useHostProjects } from "@/projects/host-projects";
import { fetchAllWorkspaceDescriptors } from "@/projects/workspace-fetching";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { shouldSuppressWorkspaceForLocalArchive } from "@/contexts/session-workspace-upserts";
import {
  buildSidebarProjectsFromHostProjects,
  computeSidebarOrderUpdates,
  deriveSidebarLoadingState,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "./sidebar-workspaces-view-model";

export {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarProjectsFromHostProjects,
  buildSidebarProjectsFromStructure,
  computeSidebarOrderUpdates,
  deriveSidebarLoadingState,
  type SidebarLoadingState,
  type SidebarOrderUpdates,
  type SidebarProjectEntry,
  type SidebarStateBucket,
  type SidebarWorkspaceEntry,
} from "./sidebar-workspaces-view-model";

function normalizeCurrentBranch(currentBranch: string | null | undefined): string | null {
  if (!currentBranch) {
    return null;
  }
  const trimmed = currentBranch.trim();
  return trimmed.length === 0 || trimmed === "HEAD" ? null : trimmed;
}

export function createSidebarWorkspaceEntry(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
  pendingCreateAttempts?: Record<string, PendingCreateAttempt>;
  agents?: Map<string, Agent>;
}): SidebarWorkspaceEntry {
  const effectiveStatus = deriveEffectiveWorkspaceStatus(input);
  return {
    workspaceKey: `${input.serverId}:${input.workspace.id}`,
    serverId: input.serverId,
    workspaceId: input.workspace.id,
    projectKey: input.workspace.project?.projectKey ?? input.workspace.projectId,
    projectRootPath: input.workspace.projectRootPath,
    workspaceDirectory: input.workspace.workspaceDirectory,
    projectKind: input.workspace.projectKind,
    workspaceKind: input.workspace.workspaceKind,
    name: input.workspace.name,
    title: input.workspace.title ?? null,
    currentBranch: normalizeCurrentBranch(input.workspace.gitRuntime?.currentBranch),
    statusBucket: effectiveStatus.status,
    statusEnteredAt: effectiveStatus.enteredAt,
    archivingAt: input.workspace.archivingAt,
    diffStat: input.workspace.diffStat,
    prHint: selectPrHintFromStatus(input.workspace.githubRuntime?.pullRequest),
    archiveHasUncommittedChanges: input.workspace.gitRuntime?.isDirty ?? null,
    archiveUnpushedCommitCount: input.workspace.gitRuntime?.aheadOfOrigin ?? null,
    scripts: input.workspace.scripts,
    hasRunningScripts: input.workspace.scripts.some((script) => script.lifecycle === "running"),
  };
}

interface EffectiveWorkspaceStatus {
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
}

interface WorkspaceAgentActivity extends EffectiveWorkspaceStatus {}

function deriveEffectiveWorkspaceStatus(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
  pendingCreateAttempts?: Record<string, PendingCreateAttempt>;
  agents?: Map<string, Agent>;
}): EffectiveWorkspaceStatus {
  if (input.workspace.status !== "done") {
    return { status: input.workspace.status, enteredAt: input.workspace.statusEnteredAt };
  }

  const pendingStartedAt = getPendingInitialAgentCreateStartedAt({
    serverId: input.serverId,
    workspaceId: input.workspace.id,
    pendingCreateAttempts: input.pendingCreateAttempts,
  });
  if (pendingStartedAt) {
    return { status: "running", enteredAt: pendingStartedAt };
  }

  const rootAgentActivity = getRootAgentWorkspaceActivity({
    workspace: input.workspace,
    agents: input.agents,
  });
  if (rootAgentActivity && rootAgentActivity.status !== "done") {
    return rootAgentActivity;
  }

  return { status: input.workspace.status, enteredAt: input.workspace.statusEnteredAt };
}

function getPendingInitialAgentCreateStartedAt(input: {
  serverId: string;
  workspaceId: string;
  pendingCreateAttempts: Record<string, PendingCreateAttempt> | undefined;
}): Date | null {
  let latestStartedAt: Date | null = null;
  for (const pending of Object.values(input.pendingCreateAttempts ?? {})) {
    if (pending.serverId !== input.serverId) continue;
    if (pending.workspaceId !== input.workspaceId) continue;
    if (pending.lifecycle === "abandoned") continue;
    const startedAt = new Date(pending.timestamp);
    if (!latestStartedAt || startedAt > latestStartedAt) {
      latestStartedAt = startedAt;
    }
  }
  return latestStartedAt;
}

function getRootAgentWorkspaceActivity(input: {
  workspace: WorkspaceDescriptor;
  agents: Map<string, Agent> | undefined;
}): WorkspaceAgentActivity | null {
  const workspaceDirectory = normalizeWorkspacePath(input.workspace.workspaceDirectory);
  if (!workspaceDirectory) {
    return null;
  }

  let latest: WorkspaceAgentActivity | null = null;
  for (const agent of input.agents?.values() ?? []) {
    if (agent.archivedAt || agent.parentAgentId) continue;
    if (normalizeWorkspacePath(agent.cwd) !== workspaceDirectory) continue;
    const status = deriveSidebarStateBucket({
      status: agent.status,
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    if (!latest || enteredAt > (latest.enteredAt ?? new Date(0))) {
      latest = { status, enteredAt };
    }
  }
  return latest;
}

export function useSidebarWorkspaceEntry(
  serverId: string | null,
  workspaceId: string | null,
): SidebarWorkspaceEntry | null {
  // Deep-compare so that adding/removing unrelated pending creates doesn't re-render this row.
  const pendingCreateAttempts = useStoreWithEqualityFn(
    useCreateFlowStore,
    (state) => state.pendingByDraftId,
    workspaceEqualityFns.deep,
  );

  // Single subscription: reads workspace + agents together, computes the full entry, and
  // deep-compares the output. Agents-Map identity churn (setAgents replaces the Map on every
  // status transition) never causes a React re-render unless the derived entry actually changes.
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const workspace = selectWorkspace(state, serverId, workspaceId);
      if (!workspace) return null;
      const agents = serverId ? state.sessions[serverId]?.agents : undefined;
      return createSidebarWorkspaceEntry({
        serverId: serverId ?? "",
        workspace,
        pendingCreateAttempts,
        agents,
      });
    },
    equal,
  );
}

const EMPTY_ORDER: string[] = [];
const EMPTY_PROJECTS: SidebarProjectEntry[] = [];

export interface SidebarWorkspacesListResult {
  projects: SidebarProjectEntry[];
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

export function useSidebarWorkspacesList(options?: {
  serverId?: string | null;
  enabled?: boolean;
}): SidebarWorkspacesListResult {
  const runtime = getHostRuntimeStore();

  const serverId = useMemo(() => {
    const value = options?.serverId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }, [options?.serverId]);
  const isActive = Boolean(serverId) && options?.enabled !== false;
  const persistedProjectOrder = useSidebarOrderStore((state) =>
    isActive && serverId ? (state.projectOrderByServerId[serverId] ?? EMPTY_ORDER) : EMPTY_ORDER,
  );
  const hasHydratedWorkspaces = useSessionStore((state) =>
    isActive && serverId ? (state.sessions[serverId]?.hasHydratedWorkspaces ?? false) : false,
  );
  const hostProjects = useHostProjects(isActive ? serverId : null);

  const connectionStatus = useSyncExternalStore(
    (onStoreChange) =>
      isActive && serverId ? runtime.subscribe(serverId, onStoreChange) : () => {},
    () => {
      if (!isActive || !serverId) {
        return "idle";
      }
      const snapshot = runtime.getSnapshot(serverId);
      return snapshot?.connectionStatus ?? "idle";
    },
    () => {
      if (!isActive || !serverId) {
        return "idle";
      }
      const snapshot = runtime.getSnapshot(serverId);
      return snapshot?.connectionStatus ?? "idle";
    },
  );

  const projects = useMemo(() => {
    if (!serverId || hostProjects.length === 0) {
      return EMPTY_PROJECTS;
    }
    return buildSidebarProjectsFromHostProjects({
      projects: hostProjects,
    });
  }, [hostProjects, serverId]);

  useEffect(() => {
    if (!serverId) {
      return;
    }
  }, [connectionStatus, hasHydratedWorkspaces, projects, serverId]);

  useEffect(() => {
    if (!serverId) {
      return;
    }

    const orderStore = useSidebarOrderStore.getState();
    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder,
      getWorkspaceOrder: (projectKey) => orderStore.getWorkspaceOrder(serverId, projectKey),
    });

    if (updates.projectOrder) {
      orderStore.setProjectOrder(serverId, updates.projectOrder);
    }
    for (const { projectKey, order } of updates.workspaceOrders) {
      orderStore.setWorkspaceOrder(serverId, projectKey, order);
    }
  }, [persistedProjectOrder, projects, serverId]);

  const refreshAll = useCallback(() => {
    if (!isActive || !serverId || connectionStatus !== "online") {
      return;
    }
    const client = runtime.getClient(serverId);
    if (!client) {
      return;
    }
    void (async () => {
      const next = new Map<string, WorkspaceDescriptor>();
      try {
        const workspaces = await fetchAllWorkspaceDescriptors({
          client,
          sort: [{ key: "activity_at", direction: "desc" }],
        });
        for (const workspace of workspaces) {
          if (shouldSuppressWorkspaceForLocalArchive({ serverId, workspace })) {
            continue;
          }
          next.set(workspace.id, workspace);
        }
        const store = useSessionStore.getState();
        store.setWorkspaces(serverId, next);
        store.setHasHydratedWorkspaces(serverId, true);
      } catch (error) {
        console.error("[WorkspaceFetch][sidebar-refresh] failed", {
          serverId,
          error,
        });
        // ignore explicit refresh failures; hook keeps existing data
      }
    })();
  }, [connectionStatus, isActive, runtime, serverId]);

  const loadingState = deriveSidebarLoadingState({
    isActive,
    serverId,
    hasHydratedWorkspaces,
    hasProjects: projects.length > 0,
  });

  return {
    projects,
    ...loadingState,
    refreshAll,
  };
}
