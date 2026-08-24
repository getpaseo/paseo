export const WORKSPACE_LABEL_COLORS = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
] as const;

export type WorkspaceLabelColor = (typeof WORKSPACE_LABEL_COLORS)[number];

export interface WorkspaceLabelDefinition {
  name: string;
  color: WorkspaceLabelColor;
}

export const RESERVED_WORKSPACE_LABEL_PREFIX = "paseo:reserved:";
export const LOGICAL_WORKSPACE_REF_LABEL_PREFIX = "paseo:reserved:v1:logical-workspace-ref=";
export const DEFAULT_WORKSPACE_PLACEMENT_LABEL = "paseo:reserved:v1:placement-role=default";
export const RESERVED_WORKSPACE_LABEL_COLOR: WorkspaceLabelColor = "indigo";

const LOGICAL_WORKSPACE_REF = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface LogicalWorkspacePlacementLabels {
  logicalWorkspaceRef: string;
  defaultPlacement: boolean;
}

export function normalizeWorkspaceLabelName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export function workspaceLabelKey(name: string): string {
  return normalizeWorkspaceLabelName(name).toLowerCase();
}

/** Reserved labels are data-plane metadata, never user-facing catalog entries. */
export function isReservedWorkspaceLabel(name: string): boolean {
  return workspaceLabelKey(name).startsWith(RESERVED_WORKSPACE_LABEL_PREFIX);
}

export function encodeLogicalWorkspaceRefLabel(logicalWorkspaceRef: string): string {
  if (!LOGICAL_WORKSPACE_REF.test(logicalWorkspaceRef)) {
    throw new Error(`Invalid logical workspace ref: ${logicalWorkspaceRef}`);
  }
  return `${LOGICAL_WORKSPACE_REF_LABEL_PREFIX}${logicalWorkspaceRef}`;
}

/**
 * Decode the closed v1 placement codec without guessing from titles, paths, or remotes.
 * Unknown and malformed reserved labels stay in storage but do not participate. Two distinct
 * valid refs are ambiguous, so the physical workspace fails open as unmanaged.
 */
export function parseLogicalWorkspacePlacementLabels(
  labels: readonly string[] | null | undefined,
): LogicalWorkspacePlacementLabels | null {
  const refs = new Set<string>();
  let defaultPlacement = false;
  const logicalPrefixKey = LOGICAL_WORKSPACE_REF_LABEL_PREFIX.toLowerCase();
  const defaultPlacementKey = DEFAULT_WORKSPACE_PLACEMENT_LABEL.toLowerCase();

  for (const label of labels ?? []) {
    const normalized = normalizeWorkspaceLabelName(label);
    const key = normalized.toLowerCase();
    if (key === defaultPlacementKey) {
      defaultPlacement = true;
      continue;
    }
    if (!key.startsWith(logicalPrefixKey)) continue;
    const logicalWorkspaceRef = normalized.slice(LOGICAL_WORKSPACE_REF_LABEL_PREFIX.length);
    if (LOGICAL_WORKSPACE_REF.test(logicalWorkspaceRef)) refs.add(logicalWorkspaceRef);
  }

  if (refs.size !== 1) return null;
  return {
    logicalWorkspaceRef: refs.values().next().value as string,
    defaultPlacement,
  };
}
