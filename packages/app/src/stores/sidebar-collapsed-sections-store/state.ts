import { z } from "zod";

export interface CollapsedProjectsState {
  collapsedProjectKeys: Set<string>;
  collapsedWorkspaceGroupKeys: Set<string>;
  collapsedPinned: boolean;
  /**
   * Per-workspace overrides for the agent sub-list, keyed by `${serverId}:${workspaceId}`.
   *
   * An override rather than a set of collapsed keys, because this is the one section whose
   * default flips with a preference: `sidebarAgentRows` is "collapsed" or "expanded". A bare set
   * would silently invert every stored row the moment the user changed that preference.
   */
  agentListOverrides: Map<string, boolean>;
}

export interface PersistedCollapsedProjects {
  collapsedProjectKeys?: string[];
  collapsedWorkspaceGroupKeys?: string[];
  collapsedStatusGroupKeys?: string[];
  collapsedPinned?: boolean;
  agentListOverrides?: Record<string, boolean>;
}

export const PersistedCollapsedProjectsSchema: z.ZodType<PersistedCollapsedProjects> =
  z.strictObject({
    collapsedProjectKeys: z.array(z.string()).optional(),
    collapsedWorkspaceGroupKeys: z.array(z.string()).optional(),
    // COMPAT(sidebarWorkspaceGroupCollapse): added in v0.4.0, remove after 2027-02-14.
    collapsedStatusGroupKeys: z.array(z.string()).optional(),
    collapsedPinned: z.boolean().optional(),
    agentListOverrides: z.record(z.string(), z.boolean()).optional(),
  });

export function togglePinnedCollapsed(state: CollapsedProjectsState): CollapsedProjectsState {
  return { ...state, collapsedPinned: !state.collapsedPinned };
}

export function toggleProjectCollapsed(
  state: CollapsedProjectsState,
  projectKey: string,
): CollapsedProjectsState {
  const next = new Set(state.collapsedProjectKeys);
  if (next.has(projectKey)) {
    next.delete(projectKey);
  } else {
    next.add(projectKey);
  }
  return { ...state, collapsedProjectKeys: next };
}

export function toggleWorkspaceGroupCollapsed(
  state: CollapsedProjectsState,
  workspaceGroupKey: string,
): CollapsedProjectsState {
  const next = new Set(state.collapsedWorkspaceGroupKeys);
  if (next.has(workspaceGroupKey)) {
    next.delete(workspaceGroupKey);
  } else {
    next.add(workspaceGroupKey);
  }
  return { ...state, collapsedWorkspaceGroupKeys: next };
}

/**
 * Flip one workspace's agent sub-list. `expandedByDefault` comes from the display preference, so
 * a toggle back to the default drops the override instead of pinning the value the user already
 * had — otherwise changing the preference would leave stale rows behind.
 */
export function toggleAgentListExpanded(
  state: CollapsedProjectsState,
  workspaceKey: string,
  expandedByDefault: boolean,
): CollapsedProjectsState {
  const current = state.agentListOverrides.get(workspaceKey) ?? expandedByDefault;
  const next = new Map(state.agentListOverrides);
  if (!current === expandedByDefault) {
    next.delete(workspaceKey);
  } else {
    next.set(workspaceKey, !current);
  }
  return { ...state, agentListOverrides: next };
}

export function isAgentListExpanded(
  state: Pick<CollapsedProjectsState, "agentListOverrides">,
  workspaceKey: string,
  expandedByDefault: boolean,
): boolean {
  return state.agentListOverrides.get(workspaceKey) ?? expandedByDefault;
}

export function setProjectCollapsed(
  state: CollapsedProjectsState,
  projectKey: string,
  collapsed: boolean,
): CollapsedProjectsState {
  const next = new Set(state.collapsedProjectKeys);
  if (collapsed) {
    next.add(projectKey);
  } else {
    next.delete(projectKey);
  }
  return { ...state, collapsedProjectKeys: next };
}

export function serializeCollapsedProjects(state: CollapsedProjectsState): {
  collapsedProjectKeys: string[];
  collapsedWorkspaceGroupKeys: string[];
  collapsedPinned: boolean;
  agentListOverrides: Record<string, boolean>;
} {
  return {
    collapsedProjectKeys: Array.from(state.collapsedProjectKeys),
    collapsedWorkspaceGroupKeys: Array.from(state.collapsedWorkspaceGroupKeys),
    collapsedPinned: state.collapsedPinned,
    agentListOverrides: Object.fromEntries(state.agentListOverrides),
  };
}

export function mergePersistedCollapsedProjects<S extends CollapsedProjectsState>(
  persistedValue: unknown,
  current: S,
): S {
  const result = PersistedCollapsedProjectsSchema.safeParse(persistedValue);
  if (!result.success) {
    return current;
  }
  const persisted = result.data;
  const restoredProjects = deserializeCollapsedKeys(
    persisted.collapsedProjectKeys ?? Array.from(current.collapsedProjectKeys),
  );
  const restoredWorkspaceGroups = deserializeCollapsedKeys(
    persisted.collapsedWorkspaceGroupKeys ??
      persisted.collapsedStatusGroupKeys ??
      Array.from(current.collapsedWorkspaceGroupKeys),
  );
  const restoredPinned = persisted.collapsedPinned ?? current.collapsedPinned;
  const restoredAgentListOverrides = persisted.agentListOverrides
    ? new Map(Object.entries(persisted.agentListOverrides))
    : current.agentListOverrides;
  if (
    areSetsEqual(current.collapsedProjectKeys, restoredProjects) &&
    areSetsEqual(current.collapsedWorkspaceGroupKeys, restoredWorkspaceGroups) &&
    current.collapsedPinned === restoredPinned &&
    areOverridesEqual(current.agentListOverrides, restoredAgentListOverrides)
  ) {
    return current;
  }
  return {
    ...current,
    collapsedProjectKeys: restoredProjects,
    collapsedWorkspaceGroupKeys: restoredWorkspaceGroups,
    collapsedPinned: restoredPinned,
    agentListOverrides: restoredAgentListOverrides,
  };
}

function areOverridesEqual(left: Map<string, boolean>, right: Map<string, boolean>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

function deserializeCollapsedKeys(value: string[]): Set<string> {
  return new Set(value);
}

function areSetsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const key of left) {
    if (!right.has(key)) {
      return false;
    }
  }
  return true;
}
