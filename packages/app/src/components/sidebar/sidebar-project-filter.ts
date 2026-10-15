import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";

// Resolve for display only; the stored list survives unavailable hosts.
export function resolveHiddenProjectKeys(
  hiddenProjectKeys: readonly string[],
  availableViewKeys: ReadonlySet<string>,
): readonly string[] {
  if (hiddenProjectKeys.length === 0) return EMPTY_PROJECT_FILTERS;
  const matching = hiddenProjectKeys.filter((viewKey) => availableViewKeys.has(viewKey));
  return matching.length > 0 ? matching : EMPTY_PROJECT_FILTERS;
}

export function filterWorkspacesByProjects(input: {
  workspaces: readonly SidebarWorkspaceEntry[];
  hiddenProjectKeys: readonly string[];
}): SidebarWorkspaceEntry[] {
  const { workspaces, hiddenProjectKeys } = input;
  if (hiddenProjectKeys.length === 0) return [...workspaces];
  const hidden = new Set(hiddenProjectKeys);
  return workspaces.filter((workspace) => !hidden.has(workspace.projectViewKey));
}

const EMPTY_PROJECT_FILTERS: readonly string[] = [];
