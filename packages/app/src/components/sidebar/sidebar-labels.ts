import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SIDEBAR_UNLABELLED_LABEL_KEY, type SidebarLabelFilter } from "@/stores/sidebar-view-store";
import type {
  WorkspaceLabelColor,
  WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import type { StatusBucket, StatusGroup } from "@/hooks/sidebar-status-view-model";

export interface SidebarLabelGroup {
  key: string;
  label: string;
  rows: SidebarWorkspaceEntry[];
  unlabelled: boolean;
  color: WorkspaceLabelColor | null;
}

export interface SidebarWorkspaceGroup {
  key: string;
  label: string;
  rows: SidebarWorkspaceEntry[];
  leading:
    | { kind: "status"; bucket: StatusBucket }
    | { kind: "label"; color: WorkspaceLabelColor | null };
}

export function statusWorkspaceGroups(groups: readonly StatusGroup[]): SidebarWorkspaceGroup[] {
  return groups.map((group) => ({
    key: group.bucket,
    label: group.label,
    rows: group.rows,
    leading: { kind: "status", bucket: group.bucket },
  }));
}

/**
 * Applies the Labels page's tri-state rows to the sidebar.
 *
 * `Unlabelled` is a row like any other, so it is a key in the same map rather than a pair of
 * booleans beside it; the only thing that makes it special is what the key asks of a workspace.
 * Exclusions win over inclusions, and `match: "all"` only has anything to say once two rows are
 * included — with one, `every` and `some` are the same question.
 */
export function filterWorkspacesByLabels(
  input: { workspaces: readonly SidebarWorkspaceEntry[] } & SidebarLabelFilter,
): SidebarWorkspaceEntry[] {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const [key, state] of Object.entries(input.labels)) {
    (state === "include" ? include : exclude).push(key);
  }
  return input.workspaces.filter((workspace) => {
    // Whitespace-only names normalize away, so `size === 0` is exactly "carries no real label"
    // and the empty key can only ever mean Unlabelled.
    const keys = new Set((workspace.labels ?? []).map(workspaceLabelKey).filter(Boolean));
    const matches = (key: string) =>
      key === SIDEBAR_UNLABELLED_LABEL_KEY ? keys.size === 0 : keys.has(key);
    if (exclude.some(matches)) return false;
    if (include.length === 0) return true;
    return input.match === "all" ? include.every(matches) : include.some(matches);
  });
}

export function groupWorkspacesByLabel(
  workspaces: readonly SidebarWorkspaceEntry[],
  unlabelledLabel: string,
  definitions: readonly WorkspaceLabelDefinition[] = [],
): SidebarLabelGroup[] {
  const colors = new Map(definitions.map((label) => [workspaceLabelKey(label.name), label.color]));
  const groups = new Map<string, SidebarLabelGroup>();
  const unlabelled: SidebarWorkspaceEntry[] = [];
  for (const workspace of workspaces) {
    const seen = new Set<string>();
    for (const label of workspace.labels ?? []) {
      const key = workspaceLabelKey(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key) ?? {
        key,
        label,
        rows: [],
        unlabelled: false,
        color: colors.get(key) ?? null,
      };
      group.rows.push(workspace);
      groups.set(key, group);
    }
    if (seen.size === 0) unlabelled.push(workspace);
  }
  const result = [...groups.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" }),
  );
  if (unlabelled.length > 0) {
    result.push({
      key: "unlabelled",
      label: unlabelledLabel,
      rows: unlabelled,
      unlabelled: true,
      color: null,
    });
  }
  return result;
}

export function labelWorkspaceGroups(
  groups: readonly SidebarLabelGroup[],
): SidebarWorkspaceGroup[] {
  return groups.map((group) => ({
    key: group.unlabelled ? "synthetic:unlabelled" : `label:${group.key}`,
    label: group.label,
    rows: group.rows,
    leading: { kind: "label", color: group.color },
  }));
}
