import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";

export interface SidebarProjectHostTarget {
  serverId: string;
  iconWorkingDir: string;
}

export type SidebarProjectTrailingAction =
  | { kind: "new_worktree"; target: SidebarProjectHostTarget }
  | { kind: "none" };

export interface SidebarProjectSectionRowModel {
  kind: "project_section";
  chevron: "expand" | "collapse";
  trailingAction: SidebarProjectTrailingAction;
}

export type SidebarProjectRowModel = SidebarProjectSectionRowModel;

function hostTarget(input: {
  serverId: string;
  iconWorkingDir: string;
}): SidebarProjectHostTarget | null {
  const iconWorkingDir = input.iconWorkingDir.trim();
  if (!input.serverId || !iconWorkingDir) {
    return null;
  }
  return { serverId: input.serverId, iconWorkingDir };
}

export function resolveSidebarProjectIconTarget(
  project: SidebarProjectEntry,
): SidebarProjectHostTarget | null {
  for (const host of project.hosts) {
    const target = hostTarget(host);
    if (target) {
      return target;
    }
  }
  return null;
}

function resolveNewWorktreeTarget(project: SidebarProjectEntry): SidebarProjectHostTarget | null {
  for (const host of project.hosts) {
    if (!host.canCreateWorktree) {
      continue;
    }
    const target = hostTarget(host);
    if (target) {
      return target;
    }
  }
  return null;
}

function projectTrailingAction(project: SidebarProjectEntry): SidebarProjectTrailingAction {
  const target = resolveNewWorktreeTarget(project);
  return target ? { kind: "new_worktree", target } : { kind: "none" };
}

export function buildSidebarProjectRowModel(input: {
  project: SidebarProjectEntry;
  collapsed: boolean;
}): SidebarProjectRowModel {
  return {
    kind: "project_section",
    chevron: input.collapsed ? "expand" : "collapse",
    trailingAction: projectTrailingAction(input.project),
  };
}
