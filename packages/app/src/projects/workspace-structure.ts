import type { EmptyProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";

export interface WorkspaceStructureHostPlacement {
  serverId: string;
  iconWorkingDir: string;
  canCreateWorktree: boolean;
}

export interface WorkspaceStructureProject {
  projectKey: string;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  hosts: WorkspaceStructureHostPlacement[];
  workspaceKeys: string[];
}

export interface WorkspaceStructure {
  projects: WorkspaceStructureProject[];
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

function canCreateWorktreeForProjectKind(projectKind: WorkspaceDescriptor["projectKind"]): boolean {
  return projectKind === "git";
}

interface WorkspaceStructureSession {
  serverId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
  emptyProjects?: Iterable<EmptyProjectDescriptor>;
}

export function buildWorkspaceStructureProjects(input: {
  sessions: WorkspaceStructureSession[];
}): WorkspaceStructureProject[] {
  const byProject = new Map<
    string,
    {
      projectKey: string;
      projectName: string;
      projectKind: WorkspaceDescriptor["projectKind"];
      iconWorkingDir: string;
      hosts: Map<string, WorkspaceStructureHostPlacement>;
      workspaces: Array<{ workspaceId: string; workspaceName: string; workspaceKey: string }>;
    }
  >();

  for (const session of input.sessions) {
    for (const emptyProject of session.emptyProjects ?? []) {
      const projectKey = emptyProject.projectId;
      const placement = {
        serverId: session.serverId,
        iconWorkingDir: emptyProject.projectRootPath,
        canCreateWorktree: canCreateWorktreeForProjectKind(emptyProject.projectKind),
      };
      const existing = byProject.get(projectKey);

      if (!existing) {
        byProject.set(projectKey, {
          projectKey,
          projectName:
            emptyProject.projectCustomName ??
            emptyProject.projectDisplayName ??
            projectDisplayNameFromProjectId(projectKey),
          projectKind: emptyProject.projectKind,
          iconWorkingDir: emptyProject.projectRootPath,
          hosts: new Map([[session.serverId, placement]]),
          workspaces: [],
        });
        continue;
      }

      existing.hosts.set(session.serverId, placement);
    }

    for (const workspace of session.workspaces) {
      const projectKey = workspace.project?.projectKey ?? workspace.projectId;
      const existing = byProject.get(projectKey);

      if (!existing) {
        byProject.set(projectKey, {
          projectKey,
          projectName:
            workspace.projectCustomName ??
            workspace.projectDisplayName ??
            projectDisplayNameFromProjectId(projectKey),
          projectKind: workspace.projectKind,
          iconWorkingDir: workspace.projectRootPath,
          hosts: new Map([
            [
              session.serverId,
              {
                serverId: session.serverId,
                iconWorkingDir: workspace.projectRootPath,
                canCreateWorktree: canCreateWorktreeForProjectKind(workspace.projectKind),
              },
            ],
          ]),
          workspaces: [
            {
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              workspaceKey: `${session.serverId}:${workspace.id}`,
            },
          ],
        });
        continue;
      }

      existing.hosts.set(session.serverId, {
        serverId: session.serverId,
        iconWorkingDir: workspace.projectRootPath,
        canCreateWorktree: canCreateWorktreeForProjectKind(workspace.projectKind),
      });
      existing.workspaces.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceKey: `${session.serverId}:${workspace.id}`,
      });
    }
  }

  const projects: WorkspaceStructureProject[] = [];
  for (const raw of byProject.values()) {
    const sortedWorkspaces = [...raw.workspaces].sort(compareWorkspaceStructureItems);
    projects.push({
      projectKey: raw.projectKey,
      projectName: raw.projectName,
      projectKind: raw.projectKind,
      iconWorkingDir: raw.iconWorkingDir,
      hosts: Array.from(raw.hosts.values()),
      workspaceKeys: sortedWorkspaces.map((w) => w.workspaceKey),
    });
  }

  projects.sort(compareWorkspaceStructureProjects);
  return projects;
}
