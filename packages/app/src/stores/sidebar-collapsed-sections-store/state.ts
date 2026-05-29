export interface CollapsedProjectsState {
  collapsedProjectKeys: Set<string>;
}

export interface PersistedCollapsedProjects {
  collapsedProjectKeys?: unknown;
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
  return { collapsedProjectKeys: next };
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
  return { collapsedProjectKeys: next };
}

export function serializeCollapsedProjects(state: CollapsedProjectsState): {
  collapsedProjectKeys: string[];
} {
  return { collapsedProjectKeys: Array.from(state.collapsedProjectKeys) };
}

export function mergePersistedCollapsedProjects<S extends CollapsedProjectsState>(
  persisted: PersistedCollapsedProjects | undefined,
  current: S,
): S {
  if (!persisted?.collapsedProjectKeys) {
    return current;
  }
  const restored = deserializeCollapsedProjectKeys(persisted.collapsedProjectKeys);
  if (areSetsEqual(current.collapsedProjectKeys, restored)) {
    return current;
  }
  return { ...current, collapsedProjectKeys: restored };
}

function deserializeCollapsedProjectKeys(value: unknown): Set<string> {
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
