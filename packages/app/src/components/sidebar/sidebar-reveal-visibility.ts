import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { filterWorkspacesByLabels } from "@/components/sidebar/sidebar-labels";
import {
  hasActiveSidebarLabelFilter,
  type SidebarGroupMode,
  type SidebarLabelFilter,
} from "@/stores/sidebar-view-store";

/**
 * What has to be true for a workspace's row to be on screen: every sidebar filter admits it, its
 * section is expanded, and background workspaces are shown. `repairRevealVisibility` walks a
 * request's workspace through those gates, clearing only the ones that actually hide it.
 *
 * The host filter is deliberately absent: it runs on the requested identity before the entry
 * lookup, because an excluded host's entries are never hydrated and the lookup would see nothing.
 */

export interface SidebarRevealFilters {
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
  clearProjectFilters(): void;
  clearLabelFilter(): void;
  showBackground(): void;
  expandProject(projectViewKey: string): void;
  expandWorkspaceGroup(groupKey: string): void;
  expandPinned(): void;
}

/**
 * `groupMode` decides which section collapse can hide the row: project sections only exist in
 * project mode and status groups only in status mode, so expanding the other mode's section
 * would change a collapse the user never saw.
 */
export function repairRevealVisibility(input: {
  entry: Pick<
    SidebarWorkspaceEntry,
    "serverId" | "projectViewKey" | "statusBucket" | "background" | "pinnedAt" | "labels"
  >;
  filters: SidebarRevealFilters;
  collapsed: SidebarRevealCollapsed;
  groupMode: SidebarGroupMode;
  actions: SidebarRevealVisibilityActions;
}): boolean {
  const { entry, filters, collapsed, groupMode, actions } = input;
  let changed = false;

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

  if (groupMode === "project" && collapsed.projectKeys.has(entry.projectViewKey)) {
    actions.expandProject(entry.projectViewKey);
    changed = true;
  }

  if (groupMode === "status" && collapsed.workspaceGroupKeys.has(entry.statusBucket)) {
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
