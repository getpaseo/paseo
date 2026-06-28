import { useCallback, useEffect, useMemo } from "react";
import equal from "fast-deep-equal";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { selectWorkspace, workspaceEqualityFns } from "@/stores/session-store-hooks/selectors";
import { useHostProjects } from "@/projects/host-projects";
import { fetchAllWorkspaceDescriptors } from "@/projects/workspace-fetching";
import { getHostRuntimeStore, useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { shouldSuppressWorkspaceForLocalArchive } from "@/contexts/session-workspace-upserts";
import {
  appendMissingOrderKeys,
  applyFlatWorkspaceOrder,
  applyStoredOrdering,
  buildSidebarWorkspacePlacementModel,
  computeSidebarOrderUpdates,
  createSidebarWorkspaceEntry,
  deriveSidebarLoadingState,
  sortSidebarWorkspacePlacementModel,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
} from "./sidebar-workspaces-view-model";

export {
  appendMissingOrderKeys,
  applyFlatWorkspaceOrder,
  applyStoredOrdering,
  buildSidebarProjectsFromHostProjects,
  buildSidebarProjectsFromStructure,
  buildSidebarStatusWorkspacePlacements,
  buildSidebarWorkspacePlacementModel,
  computeSidebarOrderUpdates,
  createSidebarWorkspaceEntry,
  deriveSidebarLoadingState,
  shouldShowSidebarHostLabels,
  sortSidebarWorkspacePlacementModel,
  type SidebarLoadingState,
  type SidebarOrderUpdates,
  type SidebarStatusWorkspacePlacement,
  type SidebarWorkspacePlacement,
  type SidebarWorkspacePlacementModel,
  type SidebarProjectEntry,
  type SidebarStateBucket,
  type SidebarWorkspaceEntry,
} from "./sidebar-workspaces-view-model";

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
const EMPTY_WORKSPACES: SidebarWorkspacePlacement[] = [];
const EMPTY_WORKSPACE_BY_KEY = new Map<string, WorkspaceDescriptor>();
const EMPTY_PROJECT_NAMES = new Map<string, string>();

export interface SidebarWorkspacesListResult {
  workspacePlacements: SidebarWorkspacePlacement[];
  projects: SidebarProjectEntry[];
  projectNamesByKey: Map<string, string>;
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  refreshAll: () => void;
}

function areWorkspaceByKeyEqual(
  a: Map<string, WorkspaceDescriptor>,
  b: Map<string, WorkspaceDescriptor>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, aValue] of a) {
    const bValue = b.get(key);
    if (!bValue || !equal(aValue, bValue)) {
      return false;
    }
  }
  return true;
}

export function useSidebarWorkspacesList(options?: {
  hostFilter?: string | null;
  enabled?: boolean;
}): SidebarWorkspacesListResult {
  const runtime = getHostRuntimeStore();
  const allHosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);

  const storeHostFilter = useSidebarViewStore((state) => state.hostFilter);
  const hostFilter = options?.hostFilter ?? storeHostFilter;
  const reconcileHostFilter = useSidebarViewStore((state) => state.reconcileHostFilter);
  const hasHostFilterMatch = hostFilter ? allServerIds.includes(hostFilter) : false;
  const effectiveHostFilter =
    hostFilter && (!hostRegistryLoaded || hasHostFilterMatch) ? hostFilter : null;
  const isActive = options?.enabled !== false;

  const serverIds = useMemo(() => {
    if (effectiveHostFilter) {
      return allServerIds.filter((id) => id === effectiveHostFilter);
    }
    return allServerIds;
  }, [allServerIds, effectiveHostFilter]);

  useEffect(() => {
    if (!hostRegistryLoaded) {
      return;
    }
    reconcileHostFilter(allServerIds);
  }, [allServerIds, hostRegistryLoaded, reconcileHostFilter]);

  const persistedProjectOrder = useSidebarOrderStore((state) => state.projectOrder ?? EMPTY_ORDER);

  const hydratedServerIds = useStoreWithEqualityFn(
    useSessionStore,
    (state) => serverIds.filter((id) => state.sessions[id]?.hasHydratedWorkspaces ?? false),
    shallow,
  );

  const hostProjects = useHostProjects(serverIds);
  const sortMode = useSidebarViewStore((state) => state.sortMode);
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const flatWorkspaceOrder = useSidebarOrderStore((state) => state.flatWorkspaceOrder);
  const workspaceOrderByProject = useSidebarOrderStore((state) => state.workspaceOrderByProject);

  const workspaceByKey = useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (sortMode === "custom") {
        return EMPTY_WORKSPACE_BY_KEY;
      }
      const map = new Map<string, WorkspaceDescriptor>();
      for (const serverId of serverIds) {
        const session = state.sessions[serverId];
        if (!session) continue;
        for (const [workspaceId, workspace] of session.workspaces) {
          map.set(`${serverId}:${workspaceId}`, workspace);
        }
      }
      return map;
    },
    areWorkspaceByKeyEqual,
  );

  const sidebarModel = useMemo(() => {
    const baseModel = buildSidebarWorkspacePlacementModel({ projects: hostProjects });

    if (sortMode === "custom") {
      const hasStoredProjectOrder = persistedProjectOrder.length > 0;
      const hasStoredWorkspaceOrder = Object.keys(workspaceOrderByProject).length > 0;
      const baselineModel =
        !hasStoredProjectOrder && !hasStoredWorkspaceOrder
          ? sortSidebarWorkspacePlacementModel({
              model: baseModel,
              workspaceByKey,
              sortMode: "alphabetical",
            })
          : baseModel;

      if (groupMode === "flat") {
        return applyFlatWorkspaceOrder(baselineModel, flatWorkspaceOrder);
      }

      const orderedProjects = applyStoredOrdering({
        items: baselineModel.projects,
        storedOrder: persistedProjectOrder,
        getKey: (project) => project.projectKey,
      });
      const nextProjects: SidebarProjectEntry[] = [];
      for (const project of orderedProjects) {
        const orderedWorkspaces = applyStoredOrdering({
          items: project.workspaces,
          storedOrder: workspaceOrderByProject[project.projectKey] ?? EMPTY_ORDER,
          getKey: (workspace) => workspace.workspaceKey,
        });
        nextProjects.push({ ...project, workspaces: orderedWorkspaces });
      }
      return {
        projects: nextProjects,
        workspaces: nextProjects.flatMap((project) => project.workspaces),
        projectNamesByKey: baselineModel.projectNamesByKey,
      };
    }

    return sortSidebarWorkspacePlacementModel({
      model: baseModel,
      workspaceByKey,
      sortMode,
    });
  }, [
    hostProjects,
    sortMode,
    groupMode,
    persistedProjectOrder,
    flatWorkspaceOrder,
    workspaceOrderByProject,
    workspaceByKey,
  ]);

  const projects = sidebarModel.projects.length > 0 ? sidebarModel.projects : EMPTY_PROJECTS;
  const workspacePlacements =
    sidebarModel.workspaces.length > 0 ? sidebarModel.workspaces : EMPTY_WORKSPACES;
  const projectNamesByKey =
    sidebarModel.projectNamesByKey.size > 0 ? sidebarModel.projectNamesByKey : EMPTY_PROJECT_NAMES;

  useEffect(() => {
    if (sortMode !== "custom") return;
    const orderStore = useSidebarOrderStore.getState();
    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder,
      getWorkspaceOrder: (projectKey) =>
        orderStore.workspaceOrderByProject[projectKey] ?? EMPTY_ORDER,
    });

    if (updates.projectOrder) {
      orderStore.setProjectOrder(updates.projectOrder);
    }
    for (const { projectKey, order } of updates.workspaceOrders) {
      orderStore.setWorkspaceOrder(projectKey, order);
    }

    const nextFlatOrder = appendMissingOrderKeys({
      currentOrder: flatWorkspaceOrder,
      visibleKeys: workspacePlacements.map((placement) => placement.workspaceKey),
    });
    if (nextFlatOrder !== flatWorkspaceOrder) {
      orderStore.setFlatWorkspaceOrder(nextFlatOrder);
    }
  }, [persistedProjectOrder, projects, workspacePlacements, sortMode, flatWorkspaceOrder]);

  const refreshAll = useCallback(() => {
    if (!isActive) return;
    for (const serverId of serverIds) {
      const snapshot = runtime.getSnapshot(serverId);
      if (snapshot?.connectionStatus !== "online") continue;
      const client = runtime.getClient(serverId);
      if (!client) continue;
      void (async () => {
        const next = new Map<string, WorkspaceDescriptor>();
        try {
          const { workspaces, emptyProjects } = await fetchAllWorkspaceDescriptors({
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
          // Keep parents with no workspaces yet, so a manual refresh doesn't drop
          // a freshly-added project from the sidebar.
          store.setEmptyProjects(serverId, emptyProjects);
          store.setHasHydratedWorkspaces(serverId, true);
        } catch (error) {
          console.error("[WorkspaceFetch][sidebar-refresh] failed", {
            serverId,
            error,
          });
          // ignore explicit refresh failures; hook keeps existing data
        }
      })();
    }
  }, [isActive, runtime, serverIds]);

  const loadingState = deriveSidebarLoadingState({
    isActive,
    serverIds,
    hydratedServerIds,
    hasProjects: projects.length > 0,
  });

  return {
    workspacePlacements,
    projects,
    projectNamesByKey,
    ...loadingState,
    refreshAll,
  };
}
