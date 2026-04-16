type WorkspaceLike = {
  id: string;
  projectId: string;
  projectDisplayName?: string;
  name: string;
  status: string;
  workspaceKind: string;
};

type SidebarWorkspaceLike = {
  workspaceId: string;
  name: string;
  statusBucket: string;
  workspaceKind: string;
};

type SidebarProjectLike = {
  projectKey: string;
  projectName: string;
  statusBucket: string;
  activeCount: number;
  totalWorkspaces: number;
  workspaces: SidebarWorkspaceLike[];
};

function countByValue(values: Iterable<string>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

export function summarizeWorkspaceCollection(
  workspaces: Iterable<WorkspaceLike> | null | undefined,
): {
  count: number;
  projectIds: string[];
  statusCounts: Record<string, number>;
  workspaces: Array<{
    id: string;
    projectId: string;
    projectDisplayName: string | null;
    name: string;
    status: string;
    workspaceKind: string;
  }>;
} {
  const entries = Array.from(workspaces ?? [], (workspace) => ({
    id: workspace.id,
    projectId: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName?.trim() || null,
    name: workspace.name,
    status: workspace.status,
    workspaceKind: workspace.workspaceKind,
  }));

  return {
    count: entries.length,
    projectIds: [...new Set(entries.map((workspace) => workspace.projectId))],
    statusCounts: countByValue(entries.map((workspace) => workspace.status)),
    workspaces: entries,
  };
}

export function summarizeSidebarProjects(
  projects: Iterable<SidebarProjectLike> | null | undefined,
): {
  count: number;
  projectKeys: string[];
  projects: Array<{
    projectKey: string;
    projectName: string;
    statusBucket: string;
    activeCount: number;
    totalWorkspaces: number;
    workspaces: Array<{
      workspaceId: string;
      name: string;
      statusBucket: string;
      workspaceKind: string;
    }>;
  }>;
} {
  const entries = Array.from(projects ?? [], (project) => ({
    projectKey: project.projectKey,
    projectName: project.projectName,
    statusBucket: project.statusBucket,
    activeCount: project.activeCount,
    totalWorkspaces: project.totalWorkspaces,
    workspaces: project.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      statusBucket: workspace.statusBucket,
      workspaceKind: workspace.workspaceKind,
    })),
  }));

  return {
    count: entries.length,
    projectKeys: entries.map((project) => project.projectKey),
    projects: entries,
  };
}
