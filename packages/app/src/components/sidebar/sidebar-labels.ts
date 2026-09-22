import {
  normalizeWorkspaceLabelName,
  workspaceLabelKey,
  type WorkspaceLabelColor,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SIDEBAR_UNLABELLED_LABEL_KEY, type SidebarLabelFilter } from "@/stores/sidebar-view-store";
import type { StatusBucket, StatusGroup } from "@/hooks/sidebar-status-view-model";

/**
 * What a group header draws before its name: the status glyph, or the label's color as a dot.
 *
 * A label whose definition the merged catalog does not carry has `color: null` — an offline host
 * still has its workspaces on screen, and a group that loses its dot is better than a group that
 * guesses a color the manager never picked.
 */
export type SidebarWorkspaceGroupLeading =
  | { kind: "status"; bucket: StatusBucket }
  | { kind: "label"; color: WorkspaceLabelColor | null };

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

/** The group key namespace, so a label and a status bucket never share a collapsed-section key. */
const LABEL_GROUP_KEY_PREFIX = "label:";
/** Outside the prefixed namespace on purpose: no label name can ever produce this key. */
const UNLABELLED_GROUP_KEY = "no-label";

/**
 * Groups the sidebar by the labels its workspaces carry.
 *
 * A workspace lands in exactly one group — the first label it was given — rather than in one per
 * label. Grouping answers "where does this workspace live", and the shortcut model walks the
 * sections this produces: a workspace drawn twice would own two shortcut numbers and take the
 * second one from a workspace that has none.
 *
 * Group order follows the catalog the Labels page defines, so the sidebar and that page read the
 * same way. A label the catalog does not carry sorts after the ones it does, by name, and
 * `Unlabelled` is always last: it is the remainder, not a label.
 */
export function labelWorkspaceGroups(input: {
  workspaces: readonly SidebarWorkspaceEntry[];
  definitions: readonly WorkspaceLabelDefinition[];
  unlabelledLabel: string;
}): SidebarWorkspaceGroup[] {
  const { workspaces, definitions, unlabelledLabel } = input;
  const catalogRank = new Map<string, number>();
  const colorsByKey = new Map<string, WorkspaceLabelColor>();
  definitions.forEach((definition, index) => {
    const key = workspaceLabelKey(definition.name);
    if (catalogRank.has(key)) return;
    catalogRank.set(key, index);
    colorsByKey.set(key, definition.color);
  });

  const groups = new Map<string, { name: string; rows: SidebarWorkspaceEntry[] }>();
  const unlabelled: SidebarWorkspaceEntry[] = [];
  for (const workspace of workspaces) {
    const primary = primaryWorkspaceLabelName(workspace);
    if (primary === null) {
      unlabelled.push(workspace);
      continue;
    }
    const key = workspaceLabelKey(primary);
    const group = groups.get(key);
    if (group) {
      group.rows.push(workspace);
      continue;
    }
    // The catalog spells the name the manager typed; the workspace only carries what it was given.
    const definitionIndex = catalogRank.get(key);
    const name = definitionIndex === undefined ? primary : definitions[definitionIndex].name;
    groups.set(key, { name, rows: [workspace] });
  }

  const ordered = [...groups.entries()].sort(([keyA, a], [keyB, b]) => {
    const rankA = catalogRank.get(keyA);
    const rankB = catalogRank.get(keyB);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });

  const result: SidebarWorkspaceGroup[] = ordered.map(([key, group]) => ({
    key: `${LABEL_GROUP_KEY_PREFIX}${key}`,
    label: group.name,
    rows: group.rows,
    leading: { kind: "label", color: colorsByKey.get(key) ?? null },
  }));
  if (unlabelled.length > 0) {
    result.push({
      key: UNLABELLED_GROUP_KEY,
      label: unlabelledLabel,
      rows: unlabelled,
      leading: { kind: "label", color: null },
    });
  }
  return result;
}

/** The label a workspace is filed under: the first it carries that survives normalization. */
function primaryWorkspaceLabelName(workspace: SidebarWorkspaceEntry): string | null {
  for (const name of workspace.labels ?? []) {
    const normalized = normalizeWorkspaceLabelName(name);
    if (normalized.length > 0) return normalized;
  }
  return null;
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
