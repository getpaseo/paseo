export interface CollapsedProjectsState {
  collapsedProjectKeys: Set<string>;
  collapsedStatusGroupKeys: Set<string>;
  collapsedBranchGroupKeys: Set<string>;
  collapsedTabGroupKeys: Set<string>;
  collapsedPinned: boolean;
}

export interface PersistedCollapsedProjects {
  collapsedProjectKeys?: unknown;
  collapsedStatusGroupKeys?: unknown;
  collapsedBranchGroupKeys?: unknown;
  collapsedTabGroupKeys?: unknown;
  collapsedPinned?: unknown;
}

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

export function toggleBranchGroupCollapsed(
  state: CollapsedProjectsState,
  branchGroupKey: string,
): CollapsedProjectsState {
  const next = new Set(state.collapsedBranchGroupKeys);
  if (next.has(branchGroupKey)) {
    next.delete(branchGroupKey);
  } else {
    next.add(branchGroupKey);
  }
  return { ...state, collapsedBranchGroupKeys: next };
}

export function toggleTabGroupCollapsed(
  state: CollapsedProjectsState,
  tabGroupKey: string,
): CollapsedProjectsState {
  const next = new Set(state.collapsedTabGroupKeys);
  if (next.has(tabGroupKey)) {
    next.delete(tabGroupKey);
  } else {
    next.add(tabGroupKey);
  }
  return { ...state, collapsedTabGroupKeys: next };
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
  collapsedStatusGroupKeys: string[];
  collapsedBranchGroupKeys: string[];
  collapsedTabGroupKeys: string[];
  collapsedPinned: boolean;
} {
  return {
    collapsedProjectKeys: Array.from(state.collapsedProjectKeys),
    collapsedStatusGroupKeys: Array.from(state.collapsedStatusGroupKeys),
    collapsedBranchGroupKeys: Array.from(state.collapsedBranchGroupKeys),
    collapsedTabGroupKeys: Array.from(state.collapsedTabGroupKeys),
    collapsedPinned: state.collapsedPinned,
  };
}

export function mergePersistedCollapsedProjects<S extends CollapsedProjectsState>(
  persisted: PersistedCollapsedProjects | undefined,
  current: S,
): S {
  if (
    !persisted?.collapsedProjectKeys &&
    !persisted?.collapsedStatusGroupKeys &&
    !persisted?.collapsedBranchGroupKeys &&
    !persisted?.collapsedTabGroupKeys &&
    persisted?.collapsedPinned === undefined
  ) {
    return current;
  }
  const restoredProjects = deserializeCollapsedKeys(persisted.collapsedProjectKeys);
  const restoredStatusGroups = deserializeCollapsedKeys(persisted.collapsedStatusGroupKeys);
  const restoredBranchGroups = deserializeCollapsedKeys(persisted.collapsedBranchGroupKeys);
  const restoredTabGroups = deserializeCollapsedKeys(persisted.collapsedTabGroupKeys);
  const restoredPinned =
    typeof persisted.collapsedPinned === "boolean"
      ? persisted.collapsedPinned
      : current.collapsedPinned;
  if (
    areSetsEqual(current.collapsedProjectKeys, restoredProjects) &&
    areSetsEqual(current.collapsedStatusGroupKeys, restoredStatusGroups) &&
    areSetsEqual(current.collapsedBranchGroupKeys, restoredBranchGroups) &&
    areSetsEqual(current.collapsedTabGroupKeys, restoredTabGroups) &&
    current.collapsedPinned === restoredPinned
  ) {
    return current;
  }
  return {
    ...current,
    collapsedProjectKeys: restoredProjects,
    collapsedStatusGroupKeys: restoredStatusGroups,
    collapsedBranchGroupKeys: restoredBranchGroups,
    collapsedTabGroupKeys: restoredTabGroups,
    collapsedPinned: restoredPinned,
  };
}

function deserializeCollapsedKeys(value: unknown): Set<string> {
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
