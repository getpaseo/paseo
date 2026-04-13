import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { isSidebarProjectFlattened } from "./sidebar-project-row-model";

export interface SidebarShortcutWorkspaceTarget {
  serverId: string;
  workspaceId: string;
}

export interface SidebarShortcutModel {
  visibleTargets: SidebarShortcutWorkspaceTarget[];
  shortcutTargets: SidebarShortcutWorkspaceTarget[];
  shortcutIndexByWorkspaceKey: Map<string, number>;
}

function createShortcutTarget(workspace: SidebarWorkspaceEntry): SidebarShortcutWorkspaceTarget {
  return {
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
  };
}

export function buildSidebarShortcutModel(input: {
  projects: SidebarProjectEntry[];
  collapsedProjectKeys: ReadonlySet<string>;
  shortcutLimit?: number;
}): SidebarShortcutModel {
  const maxShortcuts = Math.max(0, Math.floor(input.shortcutLimit ?? 9));
  const visibleTargets: SidebarShortcutWorkspaceTarget[] = [];
  const shortcutTargets: SidebarShortcutWorkspaceTarget[] = [];
  const shortcutIndexByWorkspaceKey = new Map<string, number>();

  for (const project of input.projects) {
    if (!isSidebarProjectFlattened(project) && input.collapsedProjectKeys.has(project.projectKey)) {
      continue;
    }

    for (const workspace of project.workspaces) {
      visibleTargets.push(createShortcutTarget(workspace));

      if (shortcutTargets.length >= maxShortcuts) {
        continue;
      }

      const shortcutNumber = shortcutTargets.length + 1;
      shortcutTargets.push(createShortcutTarget(workspace));
      shortcutIndexByWorkspaceKey.set(workspace.workspaceKey, shortcutNumber);
    }
  }

  return { visibleTargets, shortcutTargets, shortcutIndexByWorkspaceKey };
}
