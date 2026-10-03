import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";

export interface SidebarHostProjectEntry extends SidebarProjectEntry {
  sectionKey: string;
}

export interface SidebarHostGroup {
  key: string;
  serverId: string;
  projects: SidebarHostProjectEntry[];
}

export function sidebarHostGroupKey(serverId: string): string {
  return JSON.stringify(["sidebar-host", serverId]);
}

export function sidebarHostProjectKey(serverId: string, projectViewKey: string): string {
  return JSON.stringify(["sidebar-host-project", serverId, projectViewKey]);
}

export function sidebarProjectSectionKey(
  project: SidebarProjectEntry | SidebarHostProjectEntry,
): string {
  return "sectionKey" in project ? project.sectionKey : project.viewKey;
}

/** Reordering changes positions within a host, never project ownership. */
export function isSidebarHostProjectOrder(
  host: SidebarHostGroup,
  projects: readonly SidebarProjectEntry[],
): boolean {
  const expectedKeys = new Set(host.projects.map(sidebarProjectSectionKey));
  const keys = new Set(projects.map(sidebarProjectSectionKey));
  return (
    keys.size === projects.length &&
    keys.size === expectedKeys.size &&
    projects.every(
      (project) =>
        expectedKeys.has(sidebarProjectSectionKey(project)) &&
        project.hosts.length === 1 &&
        project.hosts[0]?.serverId === host.serverId,
    )
  );
}

export function buildSidebarHostGroups(input: {
  projects: readonly SidebarProjectEntry[];
  hostOrder?: readonly string[];
  projectOrder?: string[];
  workspaceOrderByProject?: Readonly<Record<string, string[]>>;
}): SidebarHostGroup[] {
  const groups = new Map<string, SidebarHostGroup>();
  for (const project of input.projects) {
    for (const host of project.hosts) {
      let group = groups.get(host.serverId);
      if (!group) {
        group = { key: sidebarHostGroupKey(host.serverId), serverId: host.serverId, projects: [] };
        groups.set(host.serverId, group);
      }
      const sectionKey = sidebarHostProjectKey(host.serverId, project.viewKey);
      group.projects.push({
        ...project,
        sectionKey,
        iconWorkingDir: host.iconWorkingDir,
        hosts: [host],
        workspaces: applyStoredOrdering({
          items: project.workspaces.filter((workspace) => workspace.serverId === host.serverId),
          storedOrder:
            input.workspaceOrderByProject?.[sectionKey] ??
            input.workspaceOrderByProject?.[project.viewKey] ??
            [],
          getKey: (workspace) => workspace.workspaceKey,
        }),
      });
    }
  }

  for (const group of groups.values()) {
    // Start with the existing project order; a host's own order takes precedence once set.
    group.projects = applyStoredOrdering({
      items: applyStoredOrdering({
        items: group.projects,
        storedOrder: input.projectOrder ?? [],
        getKey: (project) => project.viewKey,
      }),
      storedOrder: input.projectOrder ?? [],
      getKey: sidebarProjectSectionKey,
    });
  }
  return applyStoredOrdering({
    items: [...groups.values()],
    storedOrder: [...(input.hostOrder ?? [])],
    getKey: (group) => group.serverId,
  });
}
