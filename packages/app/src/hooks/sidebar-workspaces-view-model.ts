import type { PrHint } from "@/git/use-pr-status-query";
import {
  canCreateWorktreeForProjectKind,
  type HostProjectListItem,
} from "@/projects/host-project-model";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";

const EMPTY_PROJECTS: SidebarProjectEntry[] = [];

function workspaceNameFromDirectory(directory: string): string {
  const trimmed = directory.trim().replace(/[\\/]+$/g, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

export type SidebarStateBucket = WorkspaceDescriptor["status"];

export interface SidebarWorkspaceEntry {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  projectKey: string;
  projectRootPath?: string;
  workspaceDirectory?: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  statusBucket: SidebarStateBucket;
  statusEnteredAt: Date | null;
  archivingAt: string | null;
  diffStat: { additions: number; deletions: number } | null;
  prHint: PrHint | null;
  archiveHasUncommittedChanges: boolean | null;
  archiveUnpushedCommitCount: number | null;
  scripts: WorkspaceDescriptor["scripts"];
  hasRunningScripts: boolean;
}

export interface SidebarProjectEntry {
  projectKey: string;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  canCreateWorktree: boolean;
  workspaces: SidebarWorkspaceEntry[];
}

function createStructuralWorkspaceEntry(input: {
  serverId: string;
  project: HostProjectListItem;
  workspaceId: string;
}): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${input.serverId}:${input.workspaceId}`,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    projectKey: input.project.projectKey,
    projectRootPath: input.project.iconWorkingDir,
    workspaceDirectory: undefined,
    projectKind: input.project.projectKind,
    workspaceKind: "checkout",
    name: workspaceNameFromDirectory(input.project.iconWorkingDir) || input.workspaceId,
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

export function buildSidebarProjectsFromStructure(input: {
  serverId: string;
  projects: WorkspaceStructureProject[];
}): SidebarProjectEntry[] {
  return buildSidebarProjectsFromHostProjects({
    projects: input.projects.map((project) => ({
      serverId: input.serverId,
      projectKey: project.projectKey,
      projectName: project.projectName,
      projectKind: project.projectKind,
      iconWorkingDir: project.iconWorkingDir,
      workspaceKeys: project.workspaceKeys,
      canCreateWorktree: canCreateWorktreeForProjectKind(project.projectKind),
    })),
  });
}

export function buildSidebarProjectsFromHostProjects(input: {
  projects: readonly HostProjectListItem[];
}): SidebarProjectEntry[] {
  if (input.projects.length === 0) {
    return EMPTY_PROJECTS;
  }

  return input.projects.map((project) => ({
    projectKey: project.projectKey,
    projectName: project.projectName,
    projectKind: project.projectKind,
    iconWorkingDir: project.iconWorkingDir,
    canCreateWorktree: project.canCreateWorktree,
    workspaces: project.workspaceKeys.map((workspaceId) =>
      createStructuralWorkspaceEntry({
        serverId: project.serverId,
        project,
        workspaceId,
      }),
    ),
  }));
}

export function applyStoredOrdering<T>(input: {
  items: T[];
  storedOrder: string[];
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

export function appendMissingOrderKeys(input: {
  currentOrder: string[];
  visibleKeys: string[];
}): string[] {
  if (input.visibleKeys.length === 0) {
    return input.currentOrder;
  }

  const existingKeys = new Set(input.currentOrder);
  const missingKeys = input.visibleKeys.filter((key) => !existingKeys.has(key));
  if (missingKeys.length === 0) {
    return input.currentOrder;
  }

  return [...input.currentOrder, ...missingKeys];
}

export interface SidebarOrderUpdates {
  projectOrder: string[] | null;
  workspaceOrders: Array<{ projectKey: string; order: string[] }>;
}

export function computeSidebarOrderUpdates(input: {
  projects: SidebarProjectEntry[];
  persistedProjectOrder: string[];
  getWorkspaceOrder: (projectKey: string) => string[];
}): SidebarOrderUpdates {
  if (input.projects.length === 0) {
    return { projectOrder: null, workspaceOrders: [] };
  }

  const nextProjectOrder = appendMissingOrderKeys({
    currentOrder: input.persistedProjectOrder,
    visibleKeys: input.projects.map((project) => project.projectKey),
  });
  const projectOrder = nextProjectOrder === input.persistedProjectOrder ? null : nextProjectOrder;

  const workspaceOrders: Array<{ projectKey: string; order: string[] }> = [];
  for (const project of input.projects) {
    const persistedWorkspaceOrder = input.getWorkspaceOrder(project.projectKey);
    const nextWorkspaceOrder = appendMissingOrderKeys({
      currentOrder: persistedWorkspaceOrder,
      visibleKeys: project.workspaces.map((workspace) => workspace.workspaceKey),
    });
    if (nextWorkspaceOrder !== persistedWorkspaceOrder) {
      workspaceOrders.push({ projectKey: project.projectKey, order: nextWorkspaceOrder });
    }
  }

  return { projectOrder, workspaceOrders };
}

export interface SidebarLoadingState {
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
}

export function deriveSidebarLoadingState(input: {
  isActive: boolean;
  serverId: string | null;
  hasHydratedWorkspaces: boolean;
  hasProjects: boolean;
}): SidebarLoadingState {
  const isLoading = input.isActive && Boolean(input.serverId) && !input.hasHydratedWorkspaces;
  const isInitialLoad = isLoading && !input.hasProjects;
  return { isLoading, isInitialLoad, isRevalidating: false };
}
