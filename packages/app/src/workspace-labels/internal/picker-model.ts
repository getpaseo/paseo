import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";
import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";

export interface WorkspaceLabelPickerRow extends WorkspaceLabelDefinition {
  assigned: boolean;
}

/**
 * The host's catalog, each entry told whether this workspace carries it.
 *
 * A workspace stores names and the catalog stores definitions, and the two are only ever compared
 * through `workspaceLabelKey` — a host that accepted "Blocked" answers an assignment recorded as
 * "blocked".
 */
export function buildWorkspaceLabelPickerRows(input: {
  labels: readonly WorkspaceLabelDefinition[];
  assigned: readonly string[];
}): WorkspaceLabelPickerRow[] {
  const assigned = new Set(input.assigned.map(workspaceLabelKey));
  return input.labels.map((label) => ({
    name: label.name,
    color: label.color,
    assigned: assigned.has(workspaceLabelKey(label.name)),
  }));
}
