import {
  DEFAULT_WORKSPACE_PLACEMENT_LABEL,
  LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
  encodeLogicalWorkspaceRefLabel,
  parseLogicalWorkspacePlacementLabels,
} from "@getpaseo/protocol/workspace-labels";
import type { PluginSidebarWorkspaceGrouping } from "@/plugins/sidebar-workspace-groupings";

export interface LogicalWorkspaceSource {
  workspaceKey: string;
  serverId: string;
  name: string;
  title: string | null;
  labels: readonly string[] | null | undefined;
}

export interface LogicalWorkspaceOption {
  logicalWorkspaceRef: string;
  title: string;
  serverIds: string[];
}

export type LogicalWorkspaceCreationSelection =
  | { kind: "new"; logicalWorkspaceRef: string }
  | { kind: "existing"; logicalWorkspaceRef: string };

export const NEW_LOGICAL_WORKSPACE_OPTION_ID = "__new-logical-workspace__";

export function resolveLogicalWorkspaceRefOption(optionId: string): string | null {
  return optionId === NEW_LOGICAL_WORKSPACE_OPTION_ID ? null : optionId;
}

export function buildLogicalWorkspaceSelectionScopeKey(
  projectViewKey: string | null,
  grouping: PluginSidebarWorkspaceGrouping | null,
): string | null {
  return projectViewKey && grouping ? JSON.stringify([projectViewKey, grouping.key]) : null;
}

export function resolveLogicalWorkspaceCreationGrouping(
  groupings: readonly PluginSidebarWorkspaceGrouping[],
  serverId: string,
): PluginSidebarWorkspaceGrouping | null {
  const matching = groupings.filter(
    (grouping) => !grouping.serverIds || grouping.serverIds.includes(serverId),
  );
  return matching.length === 1 ? (matching[0] ?? null) : null;
}

export function buildLogicalWorkspaceOptions(input: {
  grouping: PluginSidebarWorkspaceGrouping;
  workspaces: readonly LogicalWorkspaceSource[];
}): LogicalWorkspaceOption[] {
  const groups = new Map<string, Array<LogicalWorkspaceSource & { defaultPlacement: boolean }>>();

  for (const workspace of input.workspaces) {
    if (input.grouping.serverIds && !input.grouping.serverIds.includes(workspace.serverId)) {
      continue;
    }
    const metadata = parseLogicalWorkspacePlacementLabels(workspace.labels);
    if (!metadata) continue;
    const members = groups.get(metadata.logicalWorkspaceRef) ?? [];
    members.push({ ...workspace, defaultPlacement: metadata.defaultPlacement });
    groups.set(metadata.logicalWorkspaceRef, members);
  }

  return [...groups.entries()]
    .map(([logicalWorkspaceRef, members]) => {
      const ordered = [...members].sort(
        (left, right) =>
          Number(right.defaultPlacement) - Number(left.defaultPlacement) ||
          left.serverId.localeCompare(right.serverId) ||
          left.workspaceKey.localeCompare(right.workspaceKey),
      );
      const display = ordered[0];
      if (!display) return null;
      return {
        logicalWorkspaceRef,
        title: display.title ?? display.name,
        serverIds: [...new Set(members.map((member) => member.serverId))].sort(),
      };
    })
    .filter((option): option is LogicalWorkspaceOption => option !== null)
    .sort(
      (left, right) =>
        left.title.localeCompare(right.title, undefined, {
          numeric: true,
          sensitivity: "base",
        }) || left.logicalWorkspaceRef.localeCompare(right.logicalWorkspaceRef),
    );
}

export function buildInitialLogicalWorkspaceLabels(input: {
  grouping: PluginSidebarWorkspaceGrouping;
  selection: LogicalWorkspaceCreationSelection;
}): string[] | undefined {
  if (
    input.grouping.logicalWorkspaceRefLabelPrefix !== LOGICAL_WORKSPACE_REF_LABEL_PREFIX ||
    input.grouping.defaultPlacementLabel !== DEFAULT_WORKSPACE_PLACEMENT_LABEL
  ) {
    return undefined;
  }
  let logicalWorkspaceRefLabel: string;
  try {
    logicalWorkspaceRefLabel = encodeLogicalWorkspaceRefLabel(input.selection.logicalWorkspaceRef);
  } catch {
    return undefined;
  }
  const labels = [logicalWorkspaceRefLabel];
  if (input.selection.kind === "new") labels.push(input.grouping.defaultPlacementLabel);
  return labels;
}
