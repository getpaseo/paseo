import type { PrTimelineEntry } from "./timeline";

export interface PullRequestActivityIdentity {
  prNumber: number;
  activityId: string;
}

export interface PullRequestActivityState {
  collapsedKeys: readonly string[];
  expandedKeys: readonly string[];
}

export interface VisiblePullRequestEntry {
  entry: PrTimelineEntry;
  collapsed: boolean;
}

export function getActivityState(): PullRequestActivityState {
  return { collapsedKeys: [], expandedKeys: [] };
}

export function getActivityStateKey(identity: PullRequestActivityIdentity): string {
  return `${identity.prNumber}:${identity.activityId}`;
}

function shouldCollapseByDefault(entry: PrTimelineEntry): boolean {
  if (entry.kind === "thread") {
    return entry.location.isResolved === true || entry.location.isOutdated === true;
  }
  if (entry.kind === "single") {
    return (
      entry.activity.location?.isResolved === true || entry.activity.location?.isOutdated === true
    );
  }
  return false;
}

export function collapseActivity(
  state: PullRequestActivityState,
  identity: PullRequestActivityIdentity,
): PullRequestActivityState {
  const key = getActivityStateKey(identity);
  if (state.collapsedKeys.includes(key)) {
    return { ...state, expandedKeys: state.expandedKeys.filter((item) => item !== key) };
  }
  return {
    ...state,
    collapsedKeys: [...state.collapsedKeys, key],
    expandedKeys: state.expandedKeys.filter((item) => item !== key),
  };
}

export function expandActivity(
  state: PullRequestActivityState,
  identity: PullRequestActivityIdentity,
): PullRequestActivityState {
  const key = getActivityStateKey(identity);
  const collapsedKeys = state.collapsedKeys.filter((item) => item !== key);
  const expandedKeys = state.expandedKeys.includes(key)
    ? state.expandedKeys
    : [...state.expandedKeys, key];
  return { ...state, collapsedKeys, expandedKeys };
}

export function getVisibleEntries(
  state: PullRequestActivityState,
  input: { prNumber: number; entries: readonly PrTimelineEntry[] },
): VisiblePullRequestEntry[] {
  return input.entries.map((entry) => {
    const key = getActivityStateKey({ prNumber: input.prNumber, activityId: entry.id });
    const collapsedByDefault = shouldCollapseByDefault(entry);
    const isExplicitlyCollapsed = state.collapsedKeys.includes(key);
    const isExplicitlyExpanded = state.expandedKeys.includes(key);

    const collapsed = isExplicitlyCollapsed || (collapsedByDefault && !isExplicitlyExpanded);

    return { entry, collapsed };
  });
}

export function getCollapsedEntryIds(
  state: PullRequestActivityState,
  input: { prNumber: number },
): ReadonlySet<string> {
  const prefix = `${input.prNumber}:`;
  return new Set(
    state.collapsedKeys
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  );
}
