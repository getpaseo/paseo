import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";

/**
 * The subset of a stored project filter that still names a project the sidebar can see.
 *
 * Empty means "all projects" — both when nothing is pinned and when everything pinned has gone
 * away. That second case is why nothing ever deletes a stored key: the project list is narrowed
 * by the host filter and is empty before any host connects, so absence does not mean the project
 * is gone. A filter goes inert while its host is away and comes back with it.
 *
 * This is the only definition of "is a project filter active". The menu's indicator, the
 * "All projects" check and the per-row selection all read it, so they cannot disagree with what
 * the list is actually doing.
 */
export function resolveActiveProjectFilters(
  projectFilters: readonly string[],
  availableViewKeys: ReadonlySet<string>,
): readonly string[] {
  if (projectFilters.length === 0) return EMPTY_PROJECT_FILTERS;
  const matching = projectFilters.filter((viewKey) => availableViewKeys.has(viewKey));
  return matching.length > 0 ? matching : EMPTY_PROJECT_FILTERS;
}

/**
 * Applies the Project page's selection to the sidebar's workspace entries.
 *
 * A workspace belongs to exactly one project, so this is a plain allowlist — no tri-state, and
 * no "unassigned" row of the kind the label filter needs.
 */
export function filterWorkspacesByProjects(input: {
  workspaces: readonly SidebarWorkspaceEntry[];
  projectFilters: readonly string[];
}): SidebarWorkspaceEntry[] {
  const { workspaces, projectFilters } = input;
  if (projectFilters.length === 0) return [...workspaces];
  const included = new Set(projectFilters);
  return workspaces.filter((workspace) => included.has(workspace.projectViewKey));
}

const EMPTY_PROJECT_FILTERS: readonly string[] = [];
