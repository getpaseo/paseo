import {
  workspaceLabelKey,
  type WorkspaceLabelColor,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SIDEBAR_UNLABELLED_LABEL_KEY, type SidebarLabelFilter } from "@/stores/sidebar-view-store";
import type { StatusBucket, StatusGroup } from "@/hooks/sidebar-status-view-model";

export type SidebarWorkspaceGroupLeading =
  | { kind: "status"; bucket: StatusBucket }
  /** `color` is null for Unlabelled, and for a name no connected catalog has defined yet. */
  | { kind: "label"; name: string | null; color: WorkspaceLabelColor | null };

export interface SidebarWorkspaceGroup {
  key: string;
  label: string;
  rows: SidebarWorkspaceEntry[];
  leading: SidebarWorkspaceGroupLeading;
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
 * The collapse key for a label section. Status keys are bucket names, so the prefix keeps a label
 * called "done" from sharing a collapsed state with the Done bucket when you switch modes.
 */
export function labelWorkspaceGroupKey(labelKey: string): string {
  return `label:${labelKey}`;
}

/**
 * One section per label in use, in catalog order, then Unlabelled.
 *
 * A workspace with several labels is listed under each of them: a label is something you
 * attached, and hiding the workspace from one of its labels would make that label lie. Labels
 * with no visible workspace get no section, the same way an empty status bucket gets none.
 *
 * Sections come from the workspaces rather than the catalog so a name whose catalog has not
 * loaded yet still groups; it just has no color until the catalog arrives.
 */
export function labelWorkspaceGroups(input: {
  workspaces: readonly SidebarWorkspaceEntry[];
  catalog: readonly WorkspaceLabelDefinition[];
  unlabelledTitle: string;
}): SidebarWorkspaceGroup[] {
  const definitionByKey = new Map(
    input.catalog.map((definition) => [workspaceLabelKey(definition.name), definition]),
  );
  const catalogOrder = new Map(
    input.catalog.map((definition, index) => [workspaceLabelKey(definition.name), index]),
  );
  const sections = new Map<string, { name: string; rows: SidebarWorkspaceEntry[] }>();
  const unlabelled: SidebarWorkspaceEntry[] = [];

  for (const workspace of input.workspaces) {
    const names = new Map<string, string>();
    for (const name of workspace.labels ?? []) {
      const key = workspaceLabelKey(name);
      if (key && !names.has(key)) names.set(key, name);
    }
    if (names.size === 0) {
      unlabelled.push(workspace);
      continue;
    }
    for (const [key, name] of names) {
      const section = sections.get(key);
      if (section) section.rows.push(workspace);
      else sections.set(key, { name: definitionByKey.get(key)?.name ?? name, rows: [workspace] });
    }
  }

  const groups: SidebarWorkspaceGroup[] = [...sections.entries()]
    .sort(([leftKey, left], [rightKey, right]) => {
      const leftOrder = catalogOrder.get(leftKey) ?? Number.POSITIVE_INFINITY;
      const rightOrder = catalogOrder.get(rightKey) ?? Number.POSITIVE_INFINITY;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    })
    .map(([key, section]) => ({
      key: labelWorkspaceGroupKey(key),
      label: section.name,
      rows: section.rows,
      leading: {
        kind: "label",
        name: section.name,
        color: definitionByKey.get(key)?.color ?? null,
      },
    }));
  if (unlabelled.length > 0) {
    groups.push({
      key: labelWorkspaceGroupKey(SIDEBAR_UNLABELLED_LABEL_KEY),
      label: input.unlabelledTitle,
      rows: unlabelled,
      leading: { kind: "label", name: null, color: null },
    });
  }
  return groups;
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
