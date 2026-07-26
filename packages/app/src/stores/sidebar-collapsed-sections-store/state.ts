export interface CollapsedProjectsState {
  expandedProjectKeys: Set<string>;
  collapsedStatusGroupKeys: Set<string>;
  collapsedPinned: boolean;
}

export interface PersistedCollapsedProjects {
  expandedProjectKeys?: unknown;
  collapsedStatusGroupKeys?: unknown;
  collapsedPinned?: unknown;
}

export function togglePinnedCollapsed(state: CollapsedProjectsState): CollapsedProjectsState {
  return { ...state, collapsedPinned: !state.collapsedPinned };
}

export function toggleProjectCollapsed(
  state: CollapsedProjectsState,
  projectKey: string,
): CollapsedProjectsState {
  const next = new Set(state.expandedProjectKeys);
  if (next.has(projectKey)) {
    next.delete(projectKey);
  } else {
    next.add(projectKey);
  }
  return { ...state, expandedProjectKeys: next };
}

export function toggleStatusGroupCollapsed(
  state: CollapsedProjectsState,
  statusGroupKey: string,
): CollapsedProjectsState {
  const next = new Set(state.collapsedStatusGroupKeys);
  if (next.has(statusGroupKey)) {
    next.delete(statusGroupKey);
  } else {
    next.add(statusGroupKey);
  }
  return { ...state, collapsedStatusGroupKeys: next };
}

export function setProjectCollapsed(
  state: CollapsedProjectsState,
  projectKey: string,
  collapsed: boolean,
): CollapsedProjectsState {
  const next = new Set(state.expandedProjectKeys);
  if (collapsed) {
    next.delete(projectKey);
  } else {
    next.add(projectKey);
  }
  return { ...state, expandedProjectKeys: next };
}

export function resolveCollapsedProjectKeys(
  projectKeys: Iterable<string>,
  expandedProjectKeys: ReadonlySet<string>,
): Set<string> {
  const collapsedProjectKeys = new Set<string>();
  for (const projectKey of projectKeys) {
    if (!expandedProjectKeys.has(projectKey)) {
      collapsedProjectKeys.add(projectKey);
    }
  }
  return collapsedProjectKeys;
}

export function serializeCollapsedProjects(state: CollapsedProjectsState): {
  expandedProjectKeys: string[];
  collapsedStatusGroupKeys: string[];
  collapsedPinned: boolean;
} {
  return {
    expandedProjectKeys: Array.from(state.expandedProjectKeys),
    collapsedStatusGroupKeys: Array.from(state.collapsedStatusGroupKeys),
    collapsedPinned: state.collapsedPinned,
  };
}

export function mergePersistedCollapsedProjects<S extends CollapsedProjectsState>(
  persisted: PersistedCollapsedProjects | undefined,
  current: S,
): S {
  if (
    !persisted?.expandedProjectKeys &&
    !persisted?.collapsedStatusGroupKeys &&
    persisted?.collapsedPinned === undefined
  ) {
    return current;
  }
  const restoredProjects = deserializeKeys(persisted.expandedProjectKeys);
  const restoredStatusGroups = deserializeKeys(persisted.collapsedStatusGroupKeys);
  const restoredPinned =
    typeof persisted.collapsedPinned === "boolean"
      ? persisted.collapsedPinned
      : current.collapsedPinned;
  if (
    areSetsEqual(current.expandedProjectKeys, restoredProjects) &&
    areSetsEqual(current.collapsedStatusGroupKeys, restoredStatusGroups) &&
    current.collapsedPinned === restoredPinned
  ) {
    return current;
  }
  return {
    ...current,
    expandedProjectKeys: restoredProjects,
    collapsedStatusGroupKeys: restoredStatusGroups,
    collapsedPinned: restoredPinned,
  };
}

function deserializeKeys(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  return new Set(value.filter((key): key is string => typeof key === "string"));
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
