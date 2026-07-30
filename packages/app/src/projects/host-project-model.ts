import type { WorkspaceDescriptor } from "@/stores/session-store";
import type {
  WorkspaceStructureHostPlacement,
  WorkspaceStructureProject,
} from "@/projects/workspace-structure";

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
    projectKey: projectId,
    projectName: trimOptional(route.displayName) || projectId,
    projectKind: "git",
    iconWorkingDir,
    hosts: [
      {
        serverId: route.serverId,
        projectId,
        iconWorkingDir,
        canCreateWorktree: true,
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
    projectKey: projectId,
    projectName: input.workspace.projectDisplayName || projectId,
    projectKind: input.workspace.projectKind,
    iconWorkingDir,
    hosts: [
      {
        serverId: input.serverId,
        projectId: input.workspace.projectId,
        iconWorkingDir,
        canCreateWorktree: canCreate,
      },
    ],
    workspaceKeys: [`${input.serverId}:${input.workspace.id}`],
  };
}

function projectCanCreateWorktree(project: HostProjectListItem): boolean {
  return project.hosts.some((h) => h.canCreateWorktree);
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
  return input.allowAllProjects || host.canCreateWorktree;
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
    const candidatePlacement = candidate.hosts.find(
      (host) => host.serverId === input.serverId && host.projectId,
    );
    const hydratedProject =
      (candidatePlacement
        ? input.projects.find((project) =>
            project.hosts.some(
              (host) =>
                host.serverId === input.serverId && host.projectId === candidatePlacement.projectId,
            ),
          )
        : undefined) ??
      input.projects.find((project) => project.projectKey === candidate.projectKey) ??
      candidate;
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
  selectedProjectKey: string | null;
  projects: readonly HostProjectListItem[];
  routeProject: HostProjectListItem | null;
  lastActiveProject: HostProjectListItem | null;
}): HostProjectListItem | null {
  const selectedProjectKey = input.selectedProjectKey?.trim() ?? "";
  if (!selectedProjectKey) {
    return null;
  }

  return (
    input.projects.find((project) => project.projectKey === selectedProjectKey) ??
    (input.routeProject?.projectKey === selectedProjectKey ? input.routeProject : null) ??
    (input.lastActiveProject?.projectKey === selectedProjectKey ? input.lastActiveProject : null)
  );
}
