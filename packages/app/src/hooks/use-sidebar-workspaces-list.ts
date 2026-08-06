import { useCallback, useEffect, useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore } from "@/stores/session-store";
import { useHydratedWorkspaceServerIds } from "@/stores/session-store-hooks";
import { workspaceEqualityFns } from "@/stores/session-store-hooks/selectors";
import { useHostProjects } from "@/projects/host-projects";
import { getHostRuntimeStore, useHostRegistryLoaded, useHosts } from "@/runtime/host-runtime";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  buildSidebarWorkspacePlacementModel,
  computeSidebarOrderUpdates,
  createSidebarWorkspaceEntry,
  deriveProjectStatusBucket,
  deriveSidebarLoadingState,
  type ProjectStatusSession,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
} from "./sidebar-workspaces-view-model";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export {
  appendMissingOrderKeys,
  applyStoredOrdering,
  buildSidebarProjectsFromHostProjects,
  buildSidebarProjectsFromStructure,
  createSidebarWorkspaceEntry,
  buildSidebarWorkspacePlacementModel,
  computeSidebarOrderUpdates,
  deriveProjectStatusBucket,
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

/**
 * Aggregate status for a project's workspaces, for the collapsed project row.
 *
 * `SidebarProjectEntry` is structural — it carries workspace identity but no status — and
 * `ProjectBlock` is memoized on that stable reference, so the row can't learn about a
 * child's status without its own subscription. Returns a primitive, so status churn in a
 * project only re-renders the row when the aggregate actually moves.
 *
 * Pass `enabled: false` while the project is expanded: the child rows show their own dots
 * and the selector is pure cost.
 */
export function useSidebarProjectStatusBucket(input: {
  workspaces: readonly SidebarWorkspacePlacement[];
  enabled: boolean;
}): SidebarStateBucket | null {
  const { workspaces, enabled } = input;
  const pendingCreateAttempts = useStoreWithEqualityFn(
    useCreateFlowStore,
    (state) => state.pendingByDraftId,
    workspaceEqualityFns.deep,
  );

  const selector = useCallback(
    (state: { sessions: Record<string, ProjectStatusSession | undefined> }) => {
      if (!enabled) return null;
      return deriveProjectStatusBucket({
        workspaces,
        sessions: state.sessions,
        pendingCreateAttempts,
      });
    },
    [enabled, pendingCreateAttempts, workspaces],
  );

  return useStoreWithEqualityFn(useSessionStore, selector, Object.is);
}

const EMPTY_ORDER: string[] = [];
const EMPTY_PROJECTS: SidebarProjectEntry[] = [];
const EMPTY_WORKSPACES: SidebarWorkspacePlacement[] = [];
const EMPTY_PROJECT_NAMES = new Map<string, string>();

export interface SidebarWorkspacesListResult {
  workspacePlacements: SidebarWorkspacePlacement[];
  projects: SidebarProjectEntry[];
  projectNamesByViewKey: Map<string, string>;
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
  const projectNamesByViewKey =
    sidebarModel.projectNamesByViewKey.size > 0
      ? sidebarModel.projectNamesByViewKey
      : EMPTY_PROJECT_NAMES;

  useEffect(() => {
    const orderStore = useSidebarOrderStore.getState();
    const updates = computeSidebarOrderUpdates({
      projects,
      persistedProjectOrder,
      getWorkspaceOrder: (projectViewKey) =>
        orderStore.workspaceOrderByProject[projectViewKey] ?? EMPTY_ORDER,
    });

    if (updates.projectOrder) {
      orderStore.setProjectOrder(updates.projectOrder);
    }
    for (const { projectViewKey, order } of updates.workspaceOrders) {
      orderStore.setWorkspaceOrder(projectViewKey, order);
    }
  }, [persistedProjectOrder, projects]);

  const refreshAll = useCallback(() => {
    if (!isActive) return;
    for (const serverId of serverIds) {
      const snapshot = runtime.getSnapshot(serverId);
      if (snapshot?.connectionStatus !== "online") continue;
      void runtime.refreshDirectories(serverId).catch((error) => {
        console.error("[WorkspaceFetch][sidebar-refresh] failed", {
          serverId,
          error,
        });
      });
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
    projectNamesByViewKey,
    ...loadingState,
    refreshAll,
  };
}
