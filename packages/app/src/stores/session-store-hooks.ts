import equal from "fast-deep-equal";
import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";
import type { DesktopBadgeWorkspaceStatus } from "@/utils/desktop-badge-state";
import {
  getWorkspaceExecutionAuthority,
  resolveWorkspaceIdByExecutionDirectory,
  resolveWorkspaceMapKeyByIdentity,
  type WorkspaceExecutionAuthorityResult,
} from "@/utils/workspace-execution";
import { useSessionStore, type WorkspaceDescriptor } from "./session-store";

// These are the ONLY supported ways to read workspaces from the session store.
// Do not write raw `useSessionStore` selectors that return the workspaces Map, a session object,
// or the sessions dict — it breaks re-render isolation.

export type { DesktopBadgeWorkspaceStatus } from "@/utils/desktop-badge-state";

export interface WorkspaceStructureProject {
  projectKey: string;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  workspaceKeys: string[];
}

export interface WorkspaceStructure {
  projects: WorkspaceStructureProject[];
}

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

const EMPTY_WORKSPACE_KEYS: string[] = [];
const EMPTY_WORKSPACE_STRUCTURE: WorkspaceStructure = { projects: [] };

function getWorkspaceOrderScopeKey(serverId: string, projectKey: string): string {
  return `${serverId.trim()}::${projectKey.trim()}`;
}

function compareWorkspaceStructureItems(
  left: { workspaceId: string; workspaceName: string },
  right: { workspaceId: string; workspaceName: string },
): number {
  const nameDelta = left.workspaceName.localeCompare(right.workspaceName, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (nameDelta !== 0) {
    return nameDelta;
  }

  return left.workspaceId.localeCompare(right.workspaceId, undefined, {
    sensitivity: "base",
  });
}

function compareWorkspaceStructureProjects(
  left: WorkspaceStructureProject,
  right: WorkspaceStructureProject,
): number {
  return left.projectName.localeCompare(right.projectName, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function applyStoredOrdering<T>(input: {
  items: T[];
  storedOrder: readonly string[];
  getKey: (item: T) => string;
}): T[] {
  if (input.items.length <= 1 || input.storedOrder.length === 0) {
    return input.items;
  }

  const itemByKey = new Map<string, T>();
  for (const item of input.items) {
    itemByKey.set(input.getKey(item), item);
  }

  const prunedOrder: string[] = [];
  const seen = new Set<string>();
  for (const key of input.storedOrder) {
    if (!itemByKey.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    prunedOrder.push(key);
  }

  if (prunedOrder.length === 0) {
    return input.items;
  }

  const orderedSet = new Set(prunedOrder);
  const ordered: T[] = [];
  let orderedIndex = 0;

  for (const item of input.items) {
    const key = input.getKey(item);
    if (!orderedSet.has(key)) {
      ordered.push(item);
      continue;
    }

    const targetKey = prunedOrder[orderedIndex] ?? key;
    orderedIndex += 1;
    ordered.push(itemByKey.get(targetKey) ?? item);
  }

  return ordered;
}

function selectWorkspace(
  state: SessionStoreSnapshot,
  serverId: string | null,
  workspaceId: string | null,
): WorkspaceDescriptor | null {
  if (!serverId || !workspaceId) {
    return null;
  }
  const workspaces = state.sessions[serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId,
  });
  return workspaceKey ? (workspaces?.get(workspaceKey) ?? null) : null;
}

export function useWorkspace(
  serverId: string | null,
  workspaceId: string | null,
): WorkspaceDescriptor | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspace(state, serverId, workspaceId),
    Object.is,
  );
}

export function useWorkspaceFields<T>(
  serverId: string | null,
  workspaceId: string | null,
  project: (w: WorkspaceDescriptor) => T,
): T | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const workspace = selectWorkspace(state, serverId, workspaceId);
      return workspace ? project(workspace) : null;
    },
    equal,
  );
}

export function useWorkspaceExecutionAuthority(
  serverId: string | null,
  workspaceId: string | null,
): WorkspaceExecutionAuthorityResult | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (serverId === null || workspaceId === null) {
        return null;
      }
      return getWorkspaceExecutionAuthority({
        workspaces: state.sessions[serverId]?.workspaces,
        workspaceId,
      });
    },
    equal,
  );
}

function selectWorkspaceStructureProjects(
  state: SessionStoreSnapshot,
  serverId: string | null,
): WorkspaceStructureProject[] {
  if (!serverId) {
    return EMPTY_WORKSPACE_STRUCTURE.projects;
  }

  const workspaces = state.sessions[serverId]?.workspaces;
  if (!workspaces || workspaces.size === 0) {
    return EMPTY_WORKSPACE_STRUCTURE.projects;
  }

  const byProject = new Map<
    string,
    WorkspaceStructureProject & {
      workspaces: Array<{ workspaceId: string; workspaceName: string; workspaceKey: string }>;
    }
  >();

  for (const workspace of workspaces.values()) {
    const project =
      byProject.get(workspace.projectId) ??
      ({
        projectKey: workspace.projectId,
        projectName:
          workspace.projectDisplayName || projectDisplayNameFromProjectId(workspace.projectId),
        projectKind: workspace.projectKind,
        iconWorkingDir: workspace.projectRootPath,
        workspaceKeys: [],
        workspaces: [],
      } satisfies WorkspaceStructureProject & {
        workspaces: Array<{ workspaceId: string; workspaceName: string; workspaceKey: string }>;
      });

    project.workspaces.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceKey: `${serverId}:${workspace.id}`,
    });
    byProject.set(workspace.projectId, project);
  }

  const projects = Array.from(byProject.values()).map(
    ({ workspaces: projectWorkspaces, ...project }) => {
      const sortedWorkspaces = [...projectWorkspaces].sort(compareWorkspaceStructureItems);

      return {
        ...project,
        workspaceKeys: sortedWorkspaces.map((workspace) => workspace.workspaceId),
      };
    },
  );

  projects.sort(compareWorkspaceStructureProjects);
  return projects;
}

function selectWorkspaceOrderByScopeForServer(
  workspaceOrderByScope: Record<string, string[]>,
  serverId: string | null,
): Record<string, string[]> {
  if (!serverId) {
    return {};
  }
  const prefix = `${serverId.trim()}::`;
  const relevantOrderByScope: Record<string, string[]> = {};
  for (const [scopeKey, order] of Object.entries(workspaceOrderByScope)) {
    if (scopeKey.startsWith(prefix)) {
      relevantOrderByScope[scopeKey] = order;
    }
  }
  return relevantOrderByScope;
}

export function useWorkspaceStructure(serverId: string | null): WorkspaceStructure {
  const projects = useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceStructureProjects(state, serverId),
    equal,
  );
  const projectOrder = useStoreWithEqualityFn(
    useSidebarOrderStore,
    (state) =>
      serverId
        ? (state.projectOrderByServerId[serverId] ?? EMPTY_WORKSPACE_KEYS)
        : EMPTY_WORKSPACE_KEYS,
    equal,
  );
  const workspaceOrderByScope = useStoreWithEqualityFn(
    useSidebarOrderStore,
    (state) =>
      selectWorkspaceOrderByScopeForServer(state.workspaceOrderByServerAndProject, serverId),
    equal,
  );

  return useMemo(() => {
    if (!serverId || projects.length === 0) {
      return EMPTY_WORKSPACE_STRUCTURE;
    }

    const orderedProjects = applyStoredOrdering({
      items: projects.map((project) => {
        const workspaceOrder =
          workspaceOrderByScope[getWorkspaceOrderScopeKey(serverId, project.projectKey)] ??
          EMPTY_WORKSPACE_KEYS;
        const workspaceItems = project.workspaceKeys.map((workspaceId) => ({
          workspaceId,
          workspaceKey: `${serverId}:${workspaceId}`,
        }));
        return {
          ...project,
          workspaceKeys: applyStoredOrdering({
            items: workspaceItems,
            storedOrder: workspaceOrder,
            getKey: (workspace) => workspace.workspaceKey,
          }).map((workspace) => workspace.workspaceId),
        };
      }),
      storedOrder: projectOrder,
      getKey: (project) => project.projectKey,
    });

    return { projects: orderedProjects };
  }, [projectOrder, projects, serverId, workspaceOrderByScope]);
}

export function useWorkspaceKeys(serverId: string | null): string[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId) {
        return EMPTY_WORKSPACE_KEYS;
      }
      const workspaces = state.sessions[serverId]?.workspaces;
      return workspaces ? Array.from(workspaces.keys()) : EMPTY_WORKSPACE_KEYS;
    },
    equal,
  );
}

export function useRecommendedProjectPaths(serverId: string | null): string[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId) {
        return EMPTY_WORKSPACE_KEYS;
      }
      const workspaces = state.sessions[serverId]?.workspaces;
      if (!workspaces) {
        return EMPTY_WORKSPACE_KEYS;
      }
      return Array.from(workspaces.values())
        .map((workspace) => workspace.projectRootPath)
        .filter((path) => path.length > 0);
    },
    equal,
  );
}

export function useHasWorkspaces(serverId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId) {
        return false;
      }
      return (state.sessions[serverId]?.workspaces?.size ?? 0) > 0;
    },
    Object.is,
  );
}

export function useResolveWorkspaceIdByCwd(
  serverId: string | null,
  cwd: string | null | undefined,
): string | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId || !cwd) {
        return null;
      }
      const workspaces = state.sessions[serverId]?.workspaces;
      return resolveWorkspaceIdByExecutionDirectory({
        workspaces: workspaces?.values(),
        workspaceDirectory: cwd,
      });
    },
    Object.is,
  );
}

export function useWorkspaceStatusesForBadges(): DesktopBadgeWorkspaceStatus[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const statuses: DesktopBadgeWorkspaceStatus[] = [];
      for (const session of Object.values(state.sessions)) {
        for (const workspace of session.workspaces.values()) {
          statuses.push(workspace.status);
        }
      }
      return statuses;
    },
    equal,
  );
}
