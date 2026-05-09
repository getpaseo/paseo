import type { SidebarSessionAgent, SidebarSessionFilter, SidebarSessionWorkspace } from "./types";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export interface SidebarSessionWorkspaceLookup {
  workspaceByExecutionKey: Map<string, SidebarSessionWorkspace>;
}

export interface SidebarSessionFilterAvailability {
  projectKeys: readonly string[];
}

export interface SidebarSessionGroup {
  projectKey: string;
  projectName: string;
  projectIconKey: string | null;
  visibleIds: readonly string[];
  hiddenCount: number;
  isExpanded: boolean;
  isCollapsed: boolean;
  totalCount: number;
}

export interface SidebarSessionAgentProject {
  id: string;
  projectKey: string;
}

const DEFAULT_GROUPED_SESSION_LIMIT = 6;

function executionKey(serverId: string, cwd: string): string {
  return `${serverId}:${cwd}`;
}

export function createSidebarSessionWorkspaceLookup(
  workspaces: readonly SidebarSessionWorkspace[],
): SidebarSessionWorkspaceLookup {
  const workspaceByExecutionKey = new Map<string, SidebarSessionWorkspace>();
  for (const workspace of workspaces) {
    const normalizedDirectory = normalizeWorkspacePath(workspace.workspaceDirectory);
    if (!normalizedDirectory) {
      continue;
    }
    workspaceByExecutionKey.set(executionKey(workspace.serverId, normalizedDirectory), workspace);
  }
  return { workspaceByExecutionKey };
}

export function resolveSidebarSessionWorkspace(
  lookup: SidebarSessionWorkspaceLookup,
  agent: SidebarSessionAgent,
): SidebarSessionWorkspace | null {
  const normalizedCwd = normalizeWorkspacePath(agent.cwd);
  if (!normalizedCwd) {
    return null;
  }
  return lookup.workspaceByExecutionKey.get(executionKey(agent.serverId, normalizedCwd)) ?? null;
}

export function resolveSidebarSessionWorkspaceId(input: {
  agent: SidebarSessionAgent;
  workspaces: Iterable<WorkspaceDescriptor> | null | undefined;
}): string | null {
  const normalizedCwd = normalizeWorkspacePath(input.agent.cwd);
  if (!normalizedCwd) {
    return null;
  }

  for (const workspace of input.workspaces ?? []) {
    if (normalizeWorkspacePath(workspace.workspaceDirectory) === normalizedCwd) {
      return workspace.id;
    }
  }
  return null;
}

export function shouldIncludeSidebarSessionAgent(input: {
  agent: SidebarSessionAgent;
  filter: SidebarSessionFilter;
  lookup: SidebarSessionWorkspaceLookup;
}): boolean {
  if (input.agent.archivedAt) {
    return false;
  }

  const workspace = resolveSidebarSessionWorkspace(input.lookup, input.agent);
  if (!workspace) {
    return false;
  }

  if (input.filter.type === "all") {
    return true;
  }
  return workspace.projectKey === input.filter.projectKey;
}

export function deriveSidebarSessionFilterAvailability(input: {
  agents: readonly SidebarSessionAgent[];
  lookup: SidebarSessionWorkspaceLookup;
}): SidebarSessionFilterAvailability {
  const projectKeys = new Set<string>();

  for (const agent of input.agents) {
    if (agent.archivedAt) {
      continue;
    }
    const workspace = resolveSidebarSessionWorkspace(input.lookup, agent);
    if (!workspace) {
      continue;
    }
    projectKeys.add(workspace.projectKey);
  }

  return {
    projectKeys: Array.from(projectKeys).sort(),
  };
}

export function deriveSidebarSessionFilterProjects(input: {
  projects: readonly SidebarProjectEntry[];
  availability: SidebarSessionFilterAvailability;
}): SidebarProjectEntry[] {
  if (input.projects.length === 0 || input.availability.projectKeys.length === 0) {
    return [];
  }

  const visibleProjectKeys = new Set(input.availability.projectKeys);
  const projects: SidebarProjectEntry[] = [];

  for (const project of input.projects) {
    if (!visibleProjectKeys.has(project.projectKey)) {
      continue;
    }
    projects.push(project);
  }

  return projects;
}

export function deriveGroupedSidebarSessions(input: {
  agentsWithProjects: readonly SidebarSessionAgentProject[];
  projects: readonly SidebarProjectEntry[];
  previewExpandedProjects?: ReadonlySet<string>;
  collapsedProjectKeys?: ReadonlySet<string>;
  limit?: number;
}): readonly SidebarSessionGroup[] {
  const limit = input.limit ?? DEFAULT_GROUPED_SESSION_LIMIT;
  const previewExpandedProjects = input.previewExpandedProjects ?? EMPTY_KEY_SET;
  const collapsedProjectKeys = input.collapsedProjectKeys ?? EMPTY_KEY_SET;

  const idsByProject = new Map<string, string[]>();
  for (const agent of input.agentsWithProjects) {
    let ids = idsByProject.get(agent.projectKey);
    if (!ids) {
      ids = [];
      idsByProject.set(agent.projectKey, ids);
    }
    ids.push(agent.id);
  }

  const groups: SidebarSessionGroup[] = [];
  for (const project of input.projects) {
    const ids = idsByProject.get(project.projectKey);
    if (!ids || ids.length === 0) {
      continue;
    }
    const isCollapsed = collapsedProjectKeys.has(project.projectKey);
    const isExpanded = !isCollapsed && previewExpandedProjects.has(project.projectKey);
    groups.push({
      projectKey: project.projectKey,
      projectName: project.projectName,
      projectIconKey: project.iconWorkingDir || null,
      visibleIds: visibleIdsFor({ ids, isCollapsed, isExpanded, limit }),
      hiddenCount: hiddenCountFor({ totalCount: ids.length, isCollapsed, isExpanded, limit }),
      isExpanded,
      isCollapsed,
      totalCount: ids.length,
    });
  }
  return groups;
}

function visibleIdsFor(input: {
  ids: readonly string[];
  isCollapsed: boolean;
  isExpanded: boolean;
  limit: number;
}): readonly string[] {
  if (input.isCollapsed) {
    return [];
  }
  if (input.isExpanded) {
    return input.ids;
  }
  return input.ids.slice(0, input.limit);
}

function hiddenCountFor(input: {
  totalCount: number;
  isCollapsed: boolean;
  isExpanded: boolean;
  limit: number;
}): number {
  if (input.isCollapsed || input.isExpanded) {
    return 0;
  }
  return Math.max(0, input.totalCount - input.limit);
}

const EMPTY_KEY_SET: ReadonlySet<string> = new Set();
