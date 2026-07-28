import type { EmptyProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";
import { resolveProjectGroupKey } from "@/projects/project-group-key";

export interface WorkspaceStructureHostPlacement {
  serverId: string;
  projectId?: string;
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

interface MaterializedWorkspaceStructureSession {
  serverId: string;
  workspaces: WorkspaceDescriptor[];
  emptyProjects: EmptyProjectDescriptor[];
}

function findAmbiguousProjectGroupKeys(
  sessions: MaterializedWorkspaceStructureSession[],
): Set<string> {
  const projectIdsByHostByGroupKey = new Map<string, Map<string, Set<string>>>();
  for (const session of sessions) {
    const projects = [
      ...session.emptyProjects.map((project) => ({
        projectId: project.projectId,
        projectGroupKey: project.projectGroupKey,
      })),
      ...session.workspaces.map((workspace) => ({
        projectId: workspace.projectId,
        projectGroupKey: workspace.projectGroupKey,
      })),
    ];
    for (const project of projects) {
      const groupKey = resolveProjectGroupKey({ serverId: session.serverId, ...project });
      const byHost = projectIdsByHostByGroupKey.get(groupKey) ?? new Map();
      const projectIds = byHost.get(session.serverId) ?? new Set();
      projectIds.add(project.projectId);
      byHost.set(session.serverId, projectIds);
      projectIdsByHostByGroupKey.set(groupKey, byHost);
    }
  }

  return new Set(
    [...projectIdsByHostByGroupKey].flatMap(([groupKey, byHost]) =>
      [...byHost.values()].some((projectIds) => projectIds.size > 1) ? [groupKey] : [],
    ),
  );
}

function resolveUnambiguousProjectGroupKey(input: {
  serverId: string;
  projectId: string;
  projectGroupKey?: string | null;
  ambiguousGroupKeys: ReadonlySet<string>;
}): string {
  const groupKey = resolveProjectGroupKey(input);
  return input.ambiguousGroupKeys.has(groupKey)
    ? `host:${input.serverId}:project:${input.projectId}`
    : groupKey;
}

export function buildWorkspaceStructureProjects(input: {
  sessions: WorkspaceStructureSession[];
}): WorkspaceStructureProject[] {
  const sessions = input.sessions.map((session) => ({
    serverId: session.serverId,
    workspaces: [...session.workspaces],
    emptyProjects: [...(session.emptyProjects ?? [])],
  }));
  const ambiguousGroupKeys = findAmbiguousProjectGroupKeys(sessions);
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

  for (const session of sessions) {
    for (const emptyProject of session.emptyProjects) {
      const projectKey = resolveUnambiguousProjectGroupKey({
        serverId: session.serverId,
        projectId: emptyProject.projectId,
        projectGroupKey: emptyProject.projectGroupKey,
        ambiguousGroupKeys,
      });
      const placement = {
        serverId: session.serverId,
        projectId: emptyProject.projectId,
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
      const projectKey = resolveUnambiguousProjectGroupKey({
        serverId: session.serverId,
        projectId: workspace.projectId,
        projectGroupKey: workspace.projectGroupKey,
        ambiguousGroupKeys,
      });
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
                projectId: workspace.projectId,
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
        projectId: workspace.projectId,
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
