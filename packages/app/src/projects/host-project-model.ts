import type { WorkspaceDescriptor } from "@/stores/session-store";
import type {
  WorkspaceStructureHostPlacement,
  WorkspaceStructureProject,
} from "@/projects/workspace-structure";
import { createProjectViewKey } from "@/projects/workspace-structure";

export type HostProjectListItem = WorkspaceStructureProject;

export interface HostProjectRouteContext {
  serverId: string;
  projectId?: string;
  displayName?: string;
  sourceDirectory?: string;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

export function canCreateWorktreeForProjectKind(
  projectKind: WorkspaceDescriptor["projectKind"],
): boolean {
  return projectKind === "git";
}

export function hostProjectFromRoute(route: HostProjectRouteContext): HostProjectListItem | null {
  const projectId = route.projectId?.trim() || undefined;
  const iconWorkingDir = trimOptional(route.sourceDirectory);
  if (!projectId || !iconWorkingDir) {
    return null;
  }
  return {
    viewKey: createProjectViewKey({ kind: "placement", serverId: route.serverId, projectId }),
    projectKey: null,
    projectName: trimOptional(route.displayName) || projectId,
    projectKind: "unknown",
    iconWorkingDir,
    hosts: [
      {
        serverId: route.serverId,
        projectId,
        iconWorkingDir,
        worktreeSupport: "unknown",
      },
    ],
    workspaceKeys: [],
  };
}

export function hostProjectFromWorkspace(input: {
  serverId: string;
  workspace: WorkspaceDescriptor | null;
}): HostProjectListItem | null {
  if (!input.workspace) {
    return null;
  }
  const projectId = input.workspace.projectId.trim() || undefined;
  if (!projectId) {
    return null;
  }
  const iconWorkingDir = input.workspace.projectRootPath.trim();
  if (!iconWorkingDir) {
    return null;
  }
  const canCreate = canCreateWorktreeForProjectKind(input.workspace.projectKind);
  return {
    viewKey: createProjectViewKey({
      kind: "placement",
      serverId: input.serverId,
      projectId,
    }),
    projectKey: null,
    projectName: input.workspace.projectDisplayName || projectId,
    projectKind: input.workspace.projectKind,
    iconWorkingDir,
    hosts: [
      {
        serverId: input.serverId,
        projectId: input.workspace.projectId,
        iconWorkingDir,
        worktreeSupport: canCreate ? "supported" : "unsupported",
      },
    ],
    workspaceKeys: [`${input.serverId}:${input.workspace.id}`],
  };
}

function projectCanCreateWorktree(project: HostProjectListItem): boolean {
  return project.hosts.some((host) => host.worktreeSupport !== "unsupported");
}

function getHostProjectPlacement(
  project: HostProjectListItem,
  serverId: string,
): WorkspaceStructureHostPlacement | null {
  for (const host of project.hosts) {
    if (host.serverId === serverId) return host;
  }
  return null;
}

export function getWorktreeSupportForHostProject(input: {
  project: HostProjectListItem;
  serverId: string;
}): WorkspaceStructureHostPlacement["worktreeSupport"] {
  return getHostProjectPlacement(input.project, input.serverId)?.worktreeSupport ?? "unknown";
}

export function getHostProjectSourceDirectory(
  project: HostProjectListItem,
  serverId: string,
): string | null {
  return getHostProjectPlacement(project, serverId)?.iconWorkingDir ?? null;
}

export function getHostProjectId(project: HostProjectListItem, serverId: string): string | null {
  return getHostProjectPlacement(project, serverId)?.projectId ?? null;
}

export function canCreateWorkspaceForHostProject(input: {
  project: HostProjectListItem;
  serverId: string;
  allowAllProjects: boolean;
}): boolean {
  const host = getHostProjectPlacement(input.project, input.serverId);
  if (!host) {
    return false;
  }
  return input.allowAllProjects || host.worktreeSupport !== "unsupported";
}

export function filterWorkspaceProjectsForHost(input: {
  projects: readonly HostProjectListItem[];
  serverId: string;
  allowAllProjects: boolean;
}): HostProjectListItem[] {
  return input.projects.filter((project) =>
    canCreateWorkspaceForHostProject({
      project,
      serverId: input.serverId,
      allowAllProjects: input.allowAllProjects,
    }),
  );
}

function compareHostProjectsForServer(
  left: HostProjectListItem,
  right: HostProjectListItem,
  serverId: string,
): number {
  return (
    left.projectName.localeCompare(right.projectName, undefined, {
      numeric: true,
      sensitivity: "base",
    }) ||
    (getHostProjectId(left, serverId) ?? "").localeCompare(
      getHostProjectId(right, serverId) ?? "",
    ) ||
    left.viewKey.localeCompare(right.viewKey)
  );
}

export function resolveExactHostProjectCandidate(input: {
  candidate: HostProjectListItem;
  projects: readonly HostProjectListItem[];
  serverId: string;
}): HostProjectListItem | null {
  const candidatePlacement = getHostProjectId(input.candidate, input.serverId);
  if (candidatePlacement) {
    const exactPlacement = input.projects.find(
      (project) => getHostProjectId(project, input.serverId) === candidatePlacement,
    );
    if (exactPlacement) return exactPlacement;
  }

  const exactView = input.projects.find((project) => project.viewKey === input.candidate.viewKey);
  if (input.candidate.projectKey !== null && exactView?.projectKey === input.candidate.projectKey) {
    return exactView;
  }

  return null;
}

export function resolveEquivalentHostProjectCandidate(input: {
  candidate: HostProjectListItem;
  projects: readonly HostProjectListItem[];
  serverId: string;
}): HostProjectListItem | null {
  if (input.candidate.projectKey === null) return null;
  const equivalents = input.projects.filter(
    (project) => project.projectKey === input.candidate.projectKey,
  );
  if (equivalents.length === 0) return null;
  return equivalents.toSorted((left, right) =>
    compareHostProjectsForServer(left, right, input.serverId),
  )[0]!;
}

export function resolveHostProjectCandidate(input: {
  candidate: HostProjectListItem;
  projects: readonly HostProjectListItem[];
  serverId: string;
}): HostProjectListItem | null {
  return resolveExactHostProjectCandidate(input) ?? resolveEquivalentHostProjectCandidate(input);
}

export function resolveInitialWorkspaceProject(input: {
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
  projects: readonly HostProjectListItem[];
  serverId: string;
  allowAllProjects: boolean;
}): HostProjectListItem | null {
  const candidates = [input.routeProject, input.lastActiveProject];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const hydratedProject =
      resolveHostProjectCandidate({
        candidate,
        projects: input.projects,
        serverId: input.serverId,
      }) ?? candidate;
    if (
      canCreateWorkspaceForHostProject({
        project: hydratedProject,
        serverId: input.serverId,
        allowAllProjects: input.allowAllProjects,
      })
    ) {
      return hydratedProject;
    }
  }

  return input.projects[0] ?? null;
}

export function resolveInitialWorktreeProject(input: {
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
  projects: readonly HostProjectListItem[];
}): HostProjectListItem | null {
  if (input.routeProject && projectCanCreateWorktree(input.routeProject)) {
    return input.routeProject;
  }
  if (input.lastActiveProject && projectCanCreateWorktree(input.lastActiveProject)) {
    return input.lastActiveProject;
  }
  return input.projects.find((project) => projectCanCreateWorktree(project)) ?? null;
}

export function resolveSelectedHostProject(input: {
  selectedViewKey: string | null;
  projects: readonly HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
}): HostProjectListItem | null {
  const selectedViewKey = input.selectedViewKey?.trim() ?? "";
  if (!selectedViewKey) {
    return null;
  }

  return (
    input.projects.find((project) => project.viewKey === selectedViewKey) ??
    (input.routeProject?.viewKey === selectedViewKey ? input.routeProject : null) ??
    (input.lastActiveProject?.viewKey === selectedViewKey ? input.lastActiveProject : null)
  );
}
