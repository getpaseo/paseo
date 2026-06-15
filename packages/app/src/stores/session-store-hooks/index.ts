import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import {
  composeWorkspaceStructure,
  selectHasHydratedWorkspaces,
  selectHasWorkspaces,
  selectProjectOrder,
  selectRecommendedProjectPaths,
  selectResolveWorkspaceIdByCwd,
  selectWorkspace,
  selectWorkspaceDirectory,
  selectWorkspaceExists,
  selectWorkspaceFields,
  selectWorkspaceKeys,
  selectWorkspaceOrderByScopeForServer,
  selectWorkspaceStatusesForBadges,
  selectWorkspaceStructureProjects,
  workspaceEqualityFns,
  type WorkspaceStructure,
} from "./selectors";
import { useSessionStore, type WorkspaceDescriptor } from "../session-store";
import type { DesktopBadgeWorkspaceStatus } from "@/utils/desktop-badge-state";

// These are the ONLY supported ways to read workspaces from the session store.
// Do not write raw `useSessionStore` selectors that return the workspaces Map, a session object,
// or the sessions dict — it breaks re-render isolation.

export type {
  DesktopBadgeWorkspaceStatus,
  WorkspaceStructure,
  WorkspaceStructureProject,
} from "./selectors";

export function useWorkspace(
  serverId: string | null,
  workspaceId: string | null,
): WorkspaceDescriptor | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspace(state, serverId, workspaceId),
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceFields<T>(
  serverId: string | null,
  workspaceId: string | null,
  project: (w: WorkspaceDescriptor) => T,
): T | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceFields(state, serverId, workspaceId, project),
    workspaceEqualityFns.deep,
  );
}

export function useWorkspaceExists(serverId: string | null, workspaceId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceExists(state, serverId, workspaceId),
    workspaceEqualityFns.identity,
  );
}

export function useHasHydratedWorkspaces(serverId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectHasHydratedWorkspaces(state, serverId),
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceDirectory(
  serverId: string | null,
  workspaceId: string | null,
): string | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceDirectory(state, serverId, workspaceId),
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceStructure(serverId: string | null): WorkspaceStructure {
  const projects = useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceStructureProjects(state, serverId),
    workspaceEqualityFns.deep,
  );
  const projectOrder = useStoreWithEqualityFn(
    useSidebarOrderStore,
    (state) => selectProjectOrder(state, serverId),
    workspaceEqualityFns.deep,
  );
  const workspaceOrderByScope = useStoreWithEqualityFn(
    useSidebarOrderStore,
    (state) => selectWorkspaceOrderByScopeForServer(state, serverId),
    workspaceEqualityFns.deep,
  );

  return useMemo(
    () =>
      composeWorkspaceStructure({
        serverId,
        projects,
        projectOrder,
        workspaceOrderByScope,
      }),
    [projectOrder, projects, serverId, workspaceOrderByScope],
  );
}

export function useWorkspaceKeys(serverId: string | null): string[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceKeys(state, serverId),
    workspaceEqualityFns.deep,
  );
}

export function useRecommendedProjectPaths(serverId: string | null): string[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectRecommendedProjectPaths(state, serverId),
    workspaceEqualityFns.deep,
  );
}

export function useHasWorkspaces(serverId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectHasWorkspaces(state, serverId),
    workspaceEqualityFns.identity,
  );
}

export function useResolveWorkspaceIdByCwd(
  serverId: string | null,
  cwd: string | null | undefined,
): string | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectResolveWorkspaceIdByCwd(state, serverId, cwd),
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceStatusesForBadges(): DesktopBadgeWorkspaceStatus[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceStatusesForBadges(state),
    workspaceEqualityFns.deep,
  );
}
