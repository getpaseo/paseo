import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
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

export function createSidebarWorkspaceEntry(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
}): SidebarWorkspaceEntry {
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
    statusBucket: input.workspace.status,
    statusEnteredAt: input.workspace.statusEnteredAt,
    archivingAt: input.workspace.archivingAt,
    diffStat: input.workspace.diffStat,
    prHint: selectPrHintFromStatus(input.workspace.githubRuntime?.pullRequest),
    archiveHasUncommittedChanges: input.workspace.gitRuntime?.isDirty ?? null,
    archiveUnpushedCommitCount: input.workspace.gitRuntime?.aheadOfOrigin ?? null,
    scripts: input.workspace.scripts,
    hasRunningScripts: input.workspace.scripts.some((script) => script.lifecycle === "running"),
  };
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
