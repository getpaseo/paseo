import { useCallback, useEffect, useMemo } from "react";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useHydratedWorkspaceServerIds } from "@/stores/session-store-hooks";
import { useHostProjects } from "@/projects/host-projects";
import { fetchAllWorkspaceDescriptors } from "@/projects/workspace-fetching";
import { getHostRuntimeStore, useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { shouldSuppressWorkspaceForLocalArchive } from "@/contexts/session-workspace-upserts";
import {
  buildSidebarWorkspacePlacementModel,
  computeSidebarOrderUpdates,
  deriveSidebarLoadingState,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
} from "./sidebar-workspaces-view-model";

export {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarProjectsFromHostProjects,
  buildSidebarProjectsFromStructure,
  createSidebarWorkspaceEntry,
  buildSidebarWorkspacePlacementModel,
  computeSidebarOrderUpdates,
  deriveSidebarLoadingState,
  shouldShowSidebarHostLabels,
  type SidebarLoadingState,
  type SidebarOrderUpdates,
  type SidebarStatusWorkspacePlacement,
  type SidebarWorkspacePlacement,
  type SidebarWorkspacePlacementModel,
  type SidebarProjectEntry,
  type SidebarStateBucket,
  type SidebarWorkspaceEntry,
} from "./sidebar-workspaces-view-model";

const EMPTY_ORDER: string[] = [];
const EMPTY_PROJECTS: SidebarProjectEntry[] = [];
const EMPTY_WORKSPACES: SidebarWorkspacePlacement[] = [];
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

export function useSidebarWorkspacesList(options?: {
  hostFilters?: readonly string[];
  enabled?: boolean;
}): SidebarWorkspacesListResult {
  const runtime = getHostRuntimeStore();
  const allHosts = useHosts();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const allServerIds = useMemo(() => allHosts.map((h) => h.serverId), [allHosts]);

  const storeHostFilters = useSidebarViewStore((state) => state.hostFilters);
  const hostFilters = options?.hostFilters ?? storeHostFilters;
  const reconcileHostFilters = useSidebarViewStore((state) => state.reconcileHostFilters);
  const isActive = options?.enabled !== false;

  const serverIds = useMemo(() => {
    if (hostFilters.length === 0) {
      return allServerIds;
    }
    const selected = new Set(hostFilters);
    const matched = allServerIds.filter((id) => selected.has(id));
    // Registry has settled but none of the pinned hosts still exist — fall back to every
    // host rather than leaving the sidebar empty.
    if (hostRegistryLoaded && matched.length === 0) {
      return allServerIds;
    }
    return matched;
  }, [allServerIds, hostFilters, hostRegistryLoaded]);

  useEffect(() => {
    if (!hostRegistryLoaded) {
      return;
    }
    reconcileHostFilters(allServerIds);
  }, [allServerIds, hostRegistryLoaded, reconcileHostFilters]);

  const persistedProjectOrder = useSidebarOrderStore((state) => state.projectOrder ?? EMPTY_ORDER);

  const hydratedServerIds = useHydratedWorkspaceServerIds(serverIds);

  const hostProjects = useHostProjects(hydratedServerIds);

  const sidebarModel = useMemo(
    () =>
      buildSidebarWorkspacePlacementModel({
        projects: hostProjects,
      }),
    [hostProjects],
  );

  const projects = sidebarModel.projects.length > 0 ? sidebarModel.projects : EMPTY_PROJECTS;
  const workspacePlacements =
    sidebarModel.workspaces.length > 0 ? sidebarModel.workspaces : EMPTY_WORKSPACES;
  const projectNamesByKey =
    sidebarModel.projectNamesByKey.size > 0 ? sidebarModel.projectNamesByKey : EMPTY_PROJECT_NAMES;

  useEffect(() => {
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
  }, [persistedProjectOrder, projects]);

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
