import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { SIDEBAR_UNLABELLED_LABEL_KEY, type SidebarLabelFilter } from "@/stores/sidebar-view-store";
import type { StatusBucket, StatusGroup } from "@/hooks/sidebar-status-view-model";

export interface SidebarWorkspaceGroup {
  key: string;
  label: string;
  rows: SidebarWorkspaceEntry[];
  leading: { kind: "status"; bucket: StatusBucket } | { kind: "project"; projectViewKey: string };
}

export function statusWorkspaceGroups(groups: readonly StatusGroup[]): SidebarWorkspaceGroup[] {
  return groups.map((group) => ({
    key: group.bucket,
    label: group.label,
    rows: group.rows,
    leading: { kind: "status", bucket: group.bucket },
  }));
}

export function pinnedProjectWorkspaceGroups(
  projects: readonly SidebarProjectEntry[],
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>,
): SidebarWorkspaceGroup[] {
  return projects.map((project) => {
    const rows: SidebarWorkspaceEntry[] = [];
    for (const placement of project.workspaces) {
      const entry = workspaceEntriesByKey.get(placement.workspaceKey);
      if (entry) rows.push(entry);
    }
    return {
      key: `pinned-project:${project.viewKey}`,
      label: project.projectName,
      rows,
      leading: { kind: "project", projectViewKey: project.viewKey },
    };
  });
}

/**
 * Applies the Labels page's selection to the sidebar.
 *
 * `Unlabelled` is a row like any other, so it is a key in the same list rather than a boolean
 * beside it; the only thing that makes it special is what the key asks of a workspace.
 * Selecting several labels includes workspaces carrying any of them.
 */
export function filterWorkspacesByLabels(
  input: { workspaces: readonly SidebarWorkspaceEntry[] } & SidebarLabelFilter,
): SidebarWorkspaceEntry[] {
  const { workspaces, labels } = input;
  if (labels.length === 0) return [...workspaces];
  return workspaces.filter((workspace) => {
    // Whitespace-only names normalize away, so `size === 0` is exactly "carries no real label"
    // and the empty key can only ever mean Unlabelled.
    const keys = new Set((workspace.labels ?? []).map(workspaceLabelKey).filter(Boolean));
    const matches = (key: string) =>
      key === SIDEBAR_UNLABELLED_LABEL_KEY ? keys.size === 0 : keys.has(key);
    return labels.some(matches);
  });
}
