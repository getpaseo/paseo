export interface CollapsedProjectsState {
  collapsedProjectKeys: Set<string>;
  collapsedStatusGroupKeys: Set<string>;
  collapsedWorkspaceKeys: Set<string>;
}

export interface PersistedCollapsedProjects {
  collapsedProjectKeys?: unknown;
  collapsedStatusGroupKeys?: unknown;
  collapsedWorkspaceKeys?: unknown;
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

export function toggleWorkspaceCollapsed(
  state: CollapsedProjectsState,
  workspaceKey: string,
): CollapsedProjectsState {
  const next = new Set(state.collapsedWorkspaceKeys);
  if (next.has(workspaceKey)) {
    next.delete(workspaceKey);
  } else {
    next.add(workspaceKey);
  }
  return { ...state, collapsedWorkspaceKeys: next };
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
  collapsedWorkspaceKeys: string[];
} {
  return {
    collapsedProjectKeys: Array.from(state.collapsedProjectKeys),
    collapsedStatusGroupKeys: Array.from(state.collapsedStatusGroupKeys),
    collapsedWorkspaceKeys: Array.from(state.collapsedWorkspaceKeys),
  };
}

export function mergePersistedCollapsedProjects<S extends CollapsedProjectsState>(
  persisted: PersistedCollapsedProjects | undefined,
  current: S,
): S {
  if (
    !persisted?.collapsedProjectKeys &&
    !persisted?.collapsedStatusGroupKeys &&
    !persisted?.collapsedWorkspaceKeys
  ) {
    return current;
  }
  const restoredProjects = deserializeCollapsedKeys(persisted.collapsedProjectKeys);
  const restoredStatusGroups = deserializeCollapsedKeys(persisted.collapsedStatusGroupKeys);
  const restoredWorkspaces = deserializeCollapsedKeys(persisted.collapsedWorkspaceKeys);
  if (
    areSetsEqual(current.collapsedProjectKeys, restoredProjects) &&
    areSetsEqual(current.collapsedStatusGroupKeys, restoredStatusGroups) &&
    areSetsEqual(current.collapsedWorkspaceKeys, restoredWorkspaces)
  ) {
    return current;
  }
  return {
    ...current,
    collapsedProjectKeys: restoredProjects,
    collapsedStatusGroupKeys: restoredStatusGroups,
    collapsedWorkspaceKeys: restoredWorkspaces,
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
