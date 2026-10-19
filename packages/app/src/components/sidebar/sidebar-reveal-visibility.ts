import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { filterWorkspacesByLabels } from "@/components/sidebar/sidebar-labels";
import { hasActiveSidebarLabelFilter, type SidebarLabelFilter } from "@/stores/sidebar-view-store";

/**
 * What has to be true for a workspace's row to be on screen: every sidebar filter admits it, its
 * section is expanded, and background workspaces are shown. `repairRevealVisibility` walks a
 * request's workspace through those gates, clearing only the ones that actually hide it.
 */

export interface SidebarRevealFilters {
  hostFilters: readonly string[];
  /** The project filter as actually applied — see `resolveActiveProjectFilters`. */
  resolvedProjectFilters: readonly string[];
  labelFilter: SidebarLabelFilter;
  showBackground: boolean;
}

export interface SidebarRevealCollapsed {
  projectKeys: ReadonlySet<string>;
  workspaceGroupKeys: ReadonlySet<string>;
  pinned: boolean;
}

export interface SidebarRevealVisibilityActions {
  clearHostFilters(): void;
  clearProjectFilters(): void;
  clearLabelFilter(): void;
  showBackground(): void;
  expandProject(projectViewKey: string): void;
  expandWorkspaceGroup(groupKey: string): void;
  expandPinned(): void;
}

export function repairRevealVisibility(input: {
  entry: Pick<
    SidebarWorkspaceEntry,
    "serverId" | "projectViewKey" | "statusBucket" | "background" | "pinnedAt" | "labels"
  >;
  filters: SidebarRevealFilters;
  collapsed: SidebarRevealCollapsed;
  actions: SidebarRevealVisibilityActions;
}): boolean {
  const { entry, filters, collapsed, actions } = input;
  let changed = false;

  const hostPinned = filters.hostFilters.length > 0;
  const hostAdmitted = !hostPinned || filters.hostFilters.includes(entry.serverId);
  if (hostPinned && !hostAdmitted) {
    actions.clearHostFilters();
    changed = true;
  }

  const projectPinned = filters.resolvedProjectFilters.length > 0;
  if (projectPinned && !filters.resolvedProjectFilters.includes(entry.projectViewKey)) {
    actions.clearProjectFilters();
    changed = true;
  }

  const labelHidesIt =
    hasActiveSidebarLabelFilter(filters.labelFilter) &&
    filterWorkspacesByLabels({ workspaces: [entry], ...filters.labelFilter }).length === 0;
  if (labelHidesIt) {
    actions.clearLabelFilter();
    changed = true;
  }

  const backgroundHidden = !filters.showBackground && entry.background;
  if (backgroundHidden) {
    actions.showBackground();
    changed = true;
  }

  if (collapsed.projectKeys.has(entry.projectViewKey)) {
    actions.expandProject(entry.projectViewKey);
    changed = true;
  }

  if (collapsed.workspaceGroupKeys.has(entry.statusBucket)) {
    actions.expandWorkspaceGroup(entry.statusBucket);
    changed = true;
  }

  const pinnedCollapsed = collapsed.pinned && entry.pinnedAt != null;
  if (pinnedCollapsed) {
    actions.expandPinned();
    changed = true;
  }

  return changed;
}
