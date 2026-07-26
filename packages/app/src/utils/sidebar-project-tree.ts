import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";

export interface SidebarProjectTreeNode {
  project: SidebarProjectEntry;
  children: SidebarProjectTreeNode[];
}

interface ProjectPathPlacement {
  serverId: string;
  path: string;
}

function normalizeProjectPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
  const withoutTrailingSlash =
    normalized === "/" || /^[A-Za-z]:\/$/u.test(normalized)
      ? normalized
      : normalized.replace(/\/+$/u, "");
  if (!withoutTrailingSlash) return null;

  return /^[A-Za-z]:\//u.test(withoutTrailingSlash)
    ? withoutTrailingSlash.toLowerCase()
    : withoutTrailingSlash;
}

function projectPathPlacements(project: SidebarProjectEntry): ProjectPathPlacement[] {
  return project.hosts.flatMap((host) => {
    const path = normalizeProjectPath(host.iconWorkingDir);
    return path ? [{ serverId: host.serverId, path }] : [];
  });
}

function isStrictDescendantPath(path: string, ancestorPath: string): boolean {
  if (path === ancestorPath) return false;
  const prefix = ancestorPath.endsWith("/") ? ancestorPath : `${ancestorPath}/`;
  return path.startsWith(prefix);
}

function parentPathLength(
  childPlacements: readonly ProjectPathPlacement[],
  parentPlacements: readonly ProjectPathPlacement[],
): number {
  let longest = -1;
  for (const child of childPlacements) {
    for (const parent of parentPlacements) {
      if (child.serverId === parent.serverId && isStrictDescendantPath(child.path, parent.path)) {
        longest = Math.max(longest, parent.path.length);
      }
    }
  }
  return longest;
}

function buildParentKeyByProject(projects: readonly SidebarProjectEntry[]): Map<string, string> {
  const placementsByProjectKey = new Map(
    projects.map((project) => [project.projectKey, projectPathPlacements(project)] as const),
  );
  const parentKeyByProject = new Map<string, string>();

  for (const child of projects) {
    const childPlacements = placementsByProjectKey.get(child.projectKey) ?? [];
    let bestParent: SidebarProjectEntry | null = null;
    let bestParentPathLength = -1;

    for (const candidate of projects) {
      if (candidate.projectKey === child.projectKey) continue;
      const candidateLength = parentPathLength(
        childPlacements,
        placementsByProjectKey.get(candidate.projectKey) ?? [],
      );
      if (candidateLength > bestParentPathLength) {
        bestParent = candidate;
        bestParentPathLength = candidateLength;
      }
    }

    if (bestParent) {
      parentKeyByProject.set(child.projectKey, bestParent.projectKey);
    }
  }

  const visited = new Set<string>();
  for (const startProjectKey of parentKeyByProject.keys()) {
    if (visited.has(startProjectKey)) continue;

    const path: string[] = [];
    const pathIndexByProjectKey = new Map<string, number>();
    let projectKey: string | undefined = startProjectKey;

    while (projectKey && !visited.has(projectKey)) {
      const cycleStartIndex = pathIndexByProjectKey.get(projectKey);
      if (cycleStartIndex !== undefined) {
        for (let index = cycleStartIndex; index < path.length; index += 1) {
          parentKeyByProject.delete(path[index]!);
        }
        break;
      }
      pathIndexByProjectKey.set(projectKey, path.length);
      path.push(projectKey);
      projectKey = parentKeyByProject.get(projectKey);
    }

    for (const visitedProjectKey of path) {
      visited.add(visitedProjectKey);
    }
  }

  return parentKeyByProject;
}

/**
 * Builds a nearest-ancestor Project tree from exact roots on the same host.
 *
 * `hierarchyProjects` may include Projects omitted from `projects` by sidebar
 * presentation filters. Required ancestors are restored as empty shells so a
 * visible child never loses its client/topic grouping.
 */
export function buildSidebarProjectTree(input: {
  projects: readonly SidebarProjectEntry[];
  hierarchyProjects?: readonly SidebarProjectEntry[];
}): SidebarProjectTreeNode[] {
  const hierarchyProjects = input.hierarchyProjects ?? input.projects;
  if (hierarchyProjects.length === 0 || input.projects.length === 0) return [];

  const parentKeyByProject = buildParentKeyByProject(hierarchyProjects);
  const visibleProjectByKey = new Map(
    input.projects.map((project) => [project.projectKey, project] as const),
  );
  const includedProjectKeys = new Set(visibleProjectByKey.keys());

  for (const project of input.projects) {
    let parentKey = parentKeyByProject.get(project.projectKey);
    while (parentKey) {
      includedProjectKeys.add(parentKey);
      parentKey = parentKeyByProject.get(parentKey);
    }
  }

  const nodeByProjectKey = new Map<string, SidebarProjectTreeNode>();
  for (const project of hierarchyProjects) {
    if (!includedProjectKeys.has(project.projectKey)) continue;
    nodeByProjectKey.set(project.projectKey, {
      project: visibleProjectByKey.get(project.projectKey) ?? { ...project, workspaces: [] },
      children: [],
    });
  }

  const roots: SidebarProjectTreeNode[] = [];
  for (const project of hierarchyProjects) {
    const node = nodeByProjectKey.get(project.projectKey);
    if (!node) continue;
    const parent = nodeByProjectKey.get(parentKeyByProject.get(project.projectKey) ?? "");
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function flattenSidebarProjectTree(
  nodes: readonly SidebarProjectTreeNode[],
): SidebarProjectEntry[] {
  const projects: SidebarProjectEntry[] = [];
  const visit = (node: SidebarProjectTreeNode) => {
    projects.push(node.project);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return projects;
}

export function expandedProjectKeysForActiveWorkspaces(input: {
  nodes: readonly SidebarProjectTreeNode[];
  activeWorkspaceKeys: ReadonlySet<string>;
}): Set<string> {
  const expandedProjectKeys = new Set<string>();

  const visit = (node: SidebarProjectTreeNode): boolean => {
    const hasActiveWorkspace = node.project.workspaces.some((workspace) =>
      input.activeWorkspaceKeys.has(workspace.workspaceKey),
    );
    const hasActiveDescendant = node.children.some(visit);
    if (hasActiveWorkspace || hasActiveDescendant) {
      expandedProjectKeys.add(node.project.projectKey);
      return true;
    }
    return false;
  };

  for (const node of input.nodes) {
    visit(node);
  }
  return expandedProjectKeys;
}

export function expandableProjectKeys(nodes: readonly SidebarProjectTreeNode[]): Set<string> {
  const projectKeys = new Set<string>();

  const visit = (node: SidebarProjectTreeNode): boolean => {
    const hasWorkspace = node.project.workspaces.length > 0;
    const hasWorkspaceDescendant = node.children.some(visit);
    if (hasWorkspace || hasWorkspaceDescendant) {
      projectKeys.add(node.project.projectKey);
      return true;
    }
    return false;
  };

  for (const node of nodes) {
    visit(node);
  }
  return projectKeys;
}

export function reorderSidebarProjectTreeChildren(input: {
  nodes: readonly SidebarProjectTreeNode[];
  parentProjectKey: string;
  reorderedChildren: SidebarProjectTreeNode[];
}): readonly SidebarProjectTreeNode[] {
  let changed = false;
  const nodes = input.nodes.map((node) => {
    if (node.project.projectKey === input.parentProjectKey) {
      changed = true;
      return { ...node, children: input.reorderedChildren };
    }

    const children = reorderSidebarProjectTreeChildren({
      nodes: node.children,
      parentProjectKey: input.parentProjectKey,
      reorderedChildren: input.reorderedChildren,
    });
    if (children === node.children) return node;
    changed = true;
    return { ...node, children: [...children] };
  });

  return changed ? nodes : input.nodes;
}
