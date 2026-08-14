import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarLabelMatch } from "@/stores/sidebar-view-store";
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

export function filterWorkspacesByLabels(input: {
  workspaces: readonly SidebarWorkspaceEntry[];
  include: readonly string[];
  exclude: readonly string[];
  includeUnlabelled: boolean;
  excludeUnlabelled: boolean;
  match: SidebarLabelMatch;
}): SidebarWorkspaceEntry[] {
  const include = new Set(input.include.map(workspaceLabelKey));
  const exclude = new Set(input.exclude.map(workspaceLabelKey));
  return input.workspaces.filter((workspace) => {
    const labels = new Set((workspace.labels ?? []).map(workspaceLabelKey));
    const unlabelled = labels.size === 0;
    if (input.excludeUnlabelled && unlabelled) return false;
    if ([...exclude].some((key) => labels.has(key))) return false;
    const positiveCount = include.size + (input.includeUnlabelled ? 1 : 0);
    if (positiveCount === 0) return true;
    const matches = [
      ...[...include].map((key) => labels.has(key)),
      ...(input.includeUnlabelled ? [unlabelled] : []),
    ];
    if (input.match === "all" && positiveCount >= 2) {
      return matches.every(Boolean);
    }
    return matches.some(Boolean);
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
