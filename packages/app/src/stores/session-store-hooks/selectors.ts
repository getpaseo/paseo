import equal from "fast-deep-equal";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";
import type { DesktopBadgeWorkspaceStatus } from "@/utils/desktop-badge-state";
import {
  getWorkspaceExecutionAuthority,
  resolveWorkspaceIdByExecutionDirectory,
  resolveWorkspaceMapKeyByIdentity,
  type WorkspaceExecutionAuthorityResult,
} from "@/utils/workspace-execution";
import type { WorkspaceDescriptor } from "../session-store";

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

export interface SessionsSnapshot {
  sessions: Record<string, { workspaces: Map<string, WorkspaceDescriptor> }>;
}

export interface SidebarOrderSnapshot {
  projectOrderByServerId: Record<string, string[]>;
  workspaceOrderByServerAndProject: Record<string, string[]>;
}

const EMPTY_WORKSPACE_KEYS: string[] = [];
const EMPTY_WORKSPACE_STRUCTURE: WorkspaceStructure = { projects: [] };

export const workspaceEqualityFns = {
  identity: Object.is as (a: unknown, b: unknown) => boolean,
  deep: equal as (a: unknown, b: unknown) => boolean,
};

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

export function selectWorkspace(
  state: SessionsSnapshot,
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

export function selectWorkspaceFields<T>(
  state: SessionsSnapshot,
  serverId: string | null,
  workspaceId: string | null,
  project: (w: WorkspaceDescriptor) => T,
): T | null {
  const workspace = selectWorkspace(state, serverId, workspaceId);
  return workspace ? project(workspace) : null;
}

export function selectWorkspaceExecutionAuthority(
  state: SessionsSnapshot,
  serverId: string | null,
  workspaceId: string | null,
): WorkspaceExecutionAuthorityResult | null {
  if (serverId === null || workspaceId === null) {
    return null;
  }
  return getWorkspaceExecutionAuthority({
    workspaces: state.sessions[serverId]?.workspaces,
    workspaceId,
  });
}

export function selectWorkspaceStructureProjects(
  state: SessionsSnapshot,
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

      return Object.assign({}, project, {
        workspaceKeys: sortedWorkspaces.map((workspace) => workspace.workspaceId),
      });
    },
  );

  projects.sort(compareWorkspaceStructureProjects);
  return projects;
}

export function selectProjectOrder(state: SidebarOrderSnapshot, serverId: string | null): string[] {
  return serverId
    ? (state.projectOrderByServerId[serverId] ?? EMPTY_WORKSPACE_KEYS)
    : EMPTY_WORKSPACE_KEYS;
}

export function selectWorkspaceOrderByScopeForServer(
  state: SidebarOrderSnapshot,
  serverId: string | null,
): Record<string, string[]> {
  if (!serverId) {
    return {};
  }
  const prefix = `${serverId.trim()}::`;
  const relevantOrderByScope: Record<string, string[]> = {};
  for (const [scopeKey, order] of Object.entries(state.workspaceOrderByServerAndProject)) {
    if (scopeKey.startsWith(prefix)) {
      relevantOrderByScope[scopeKey] = order;
    }
  }
  return relevantOrderByScope;
}

export function composeWorkspaceStructure(input: {
  serverId: string | null;
  projects: WorkspaceStructureProject[];
  projectOrder: readonly string[];
  workspaceOrderByScope: Record<string, readonly string[]>;
}): WorkspaceStructure {
  if (!input.serverId || input.projects.length === 0) {
    return EMPTY_WORKSPACE_STRUCTURE;
  }

  const orderedProjects = applyStoredOrdering({
    items: input.projects.map((project) => {
      const workspaceOrder =
        input.workspaceOrderByScope[
          getWorkspaceOrderScopeKey(input.serverId as string, project.projectKey)
        ] ?? EMPTY_WORKSPACE_KEYS;
      const workspaceItems = project.workspaceKeys.map((workspaceId) => ({
        workspaceId,
        workspaceKey: `${input.serverId as string}:${workspaceId}`,
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
    storedOrder: input.projectOrder,
    getKey: (project) => project.projectKey,
  });

  return { projects: orderedProjects };
}

export function selectWorkspaceKeys(state: SessionsSnapshot, serverId: string | null): string[] {
  if (!serverId) {
    return EMPTY_WORKSPACE_KEYS;
  }
  const workspaces = state.sessions[serverId]?.workspaces;
  return workspaces ? Array.from(workspaces.keys()) : EMPTY_WORKSPACE_KEYS;
}

export function selectRecommendedProjectPaths(
  state: SessionsSnapshot,
  serverId: string | null,
): string[] {
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
}

export function selectHasWorkspaces(state: SessionsSnapshot, serverId: string | null): boolean {
  if (!serverId) {
    return false;
  }
  return (state.sessions[serverId]?.workspaces?.size ?? 0) > 0;
}

export function selectResolveWorkspaceIdByCwd(
  state: SessionsSnapshot,
  serverId: string | null,
  cwd: string | null | undefined,
): string | null {
  if (!serverId || !cwd) {
    return null;
  }
  const workspaces = state.sessions[serverId]?.workspaces;
  return resolveWorkspaceIdByExecutionDirectory({
    workspaces: workspaces?.values(),
    workspaceDirectory: cwd,
  });
}

export function selectWorkspaceStatusesForBadges(
  state: SessionsSnapshot,
): DesktopBadgeWorkspaceStatus[] {
  const statuses: DesktopBadgeWorkspaceStatus[] = [];
  for (const session of Object.values(state.sessions)) {
    for (const workspace of session.workspaces.values()) {
      statuses.push(workspace.status);
    }
  }
  return statuses;
}
