import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";

export interface NestedProject {
  project: SidebarProjectEntry;
  depth: number;
}

function normalizedPath(path: string): string {
  const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith("\\\\");
  const value = windows ? path.replaceAll("\\", "/") : path;
  return value.replace(/\/+$/, "") || "/";
}

function containsPath(parent: string, child: string): boolean {
  const root = normalizedPath(parent);
  const path = normalizedPath(child);
  return path !== root && path.startsWith(root === "/" ? "/" : `${root}/`);
}

/** Keep multi-host projects flat unless all their hosts agree on the same parent. */
export function nestSidebarProjects(
  projects: readonly SidebarProjectEntry[],
  collapsed: ReadonlySet<string>,
): NestedProject[] {
  const children = new Map<string | null, SidebarProjectEntry[]>();
  for (const project of projects) {
    const parents = project.hosts.map((host) => {
      let nearest: SidebarProjectEntry | null = null;
      let longest = -1;
      for (const candidate of projects) {
        if (candidate === project) continue;
        const parentHost = candidate.hosts.find((entry) => entry.serverId === host.serverId);
        if (!parentHost || !containsPath(parentHost.iconWorkingDir, host.iconWorkingDir)) continue;
        const length = normalizedPath(parentHost.iconWorkingDir).length;
        if (length > longest) {
          nearest = candidate;
          longest = length;
        }
      }
      return nearest?.viewKey ?? null;
    });
    const firstParent = parents[0] ?? null;
    const parent = firstParent && parents.every((key) => key === firstParent) ? firstParent : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(project);
    children.set(parent, siblings);
  }

  const result: NestedProject[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const project of children.get(parent) ?? []) {
      result.push({ project, depth });
      if (!collapsed.has(project.viewKey)) walk(project.viewKey, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}
