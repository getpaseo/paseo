import { z } from "zod";

export interface CollapsedProjectsState {
  collapsedProjectKeys: Set<string>;
  collapsedWorkspaceGroupKeys: Set<string>;
  // Keyed by projectGroupKey(name) (trimmed + lowercased), not a stable id — a project group has
  // no catalog record, so its identity is its normalized name. Renaming a group therefore changes
  // its key and re-expands it on every device. Accepted for v1; see docs/glossary.md "Group".
  collapsedProjectGroupKeys: Set<string>;
  collapsedPinned: boolean;
}

export interface PersistedCollapsedProjects {
  collapsedProjectKeys?: string[];
  collapsedWorkspaceGroupKeys?: string[];
  collapsedStatusGroupKeys?: string[];
  collapsedProjectGroupKeys?: string[];
  collapsedPinned?: boolean;
}

export const PersistedCollapsedProjectsSchema: z.ZodType<PersistedCollapsedProjects> =
  z.strictObject({
    collapsedProjectKeys: z.array(z.string()).optional(),
    collapsedWorkspaceGroupKeys: z.array(z.string()).optional(),
    // COMPAT(sidebarWorkspaceGroupCollapse): added in v0.4.0, remove after 2027-02-14.
    collapsedStatusGroupKeys: z.array(z.string()).optional(),
    collapsedProjectGroupKeys: z.array(z.string()).optional(),
    collapsedPinned: z.boolean().optional(),
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

export function toggleProjectGroupCollapsed(
  state: CollapsedProjectsState,
  projectGroupKey: string,
): CollapsedProjectsState {
  const next = new Set(state.collapsedProjectGroupKeys);
  if (next.has(projectGroupKey)) {
    next.delete(projectGroupKey);
  } else {
    next.add(projectGroupKey);
  }
  return { ...state, collapsedProjectGroupKeys: next };
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
  collapsedProjectGroupKeys: string[];
  collapsedPinned: boolean;
} {
  return {
    collapsedProjectKeys: Array.from(state.collapsedProjectKeys),
    collapsedWorkspaceGroupKeys: Array.from(state.collapsedWorkspaceGroupKeys),
    collapsedProjectGroupKeys: Array.from(state.collapsedProjectGroupKeys),
    collapsedPinned: state.collapsedPinned,
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
  // Old persisted state predates project groups and has no key at all: falling back to
  // `current` is safe because merge only ever runs against the freshly created store state
  // (empty sets), so an old persisted blob restores an empty collapsedProjectGroupKeys set.
  const restoredProjectGroups = deserializeCollapsedKeys(
    persisted.collapsedProjectGroupKeys ?? Array.from(current.collapsedProjectGroupKeys),
  );
  const restoredPinned = persisted.collapsedPinned ?? current.collapsedPinned;
  if (
    areSetsEqual(current.collapsedProjectKeys, restoredProjects) &&
    areSetsEqual(current.collapsedWorkspaceGroupKeys, restoredWorkspaceGroups) &&
    areSetsEqual(current.collapsedProjectGroupKeys, restoredProjectGroups) &&
    current.collapsedPinned === restoredPinned
  ) {
    return current;
  }
  return {
    ...current,
    collapsedProjectKeys: restoredProjects,
    collapsedWorkspaceGroupKeys: restoredWorkspaceGroups,
    collapsedProjectGroupKeys: restoredProjectGroups,
    collapsedPinned: restoredPinned,
  };
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
