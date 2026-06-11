import type { PrTimelineEntry } from "./timeline";

export interface PullRequestActivityIdentity {
  prNumber: number;
  activityId: string;
}

export interface PullRequestActivityState {
  collapsedKeys: readonly string[];
  hiddenKeys: readonly string[];
}

export interface VisiblePullRequestEntry {
  entry: PrTimelineEntry;
  collapsed: boolean;
}

export function getActivityState(): PullRequestActivityState {
  return { collapsedKeys: [], hiddenKeys: [] };
}

export function getActivityStateKey(identity: PullRequestActivityIdentity): string {
  return `${identity.prNumber}:${identity.activityId}`;
}

export function collapseActivity(
  state: PullRequestActivityState,
  identity: PullRequestActivityIdentity,
): PullRequestActivityState {
  const key = getActivityStateKey(identity);
  if (state.collapsedKeys.includes(key)) {
    return state;
  }
  return { ...state, collapsedKeys: [...state.collapsedKeys, key] };
}

export function expandActivity(
  state: PullRequestActivityState,
  identity: PullRequestActivityIdentity,
): PullRequestActivityState {
  const key = getActivityStateKey(identity);
  return { ...state, collapsedKeys: state.collapsedKeys.filter((item) => item !== key) };
}

export function hideActivity(
  state: PullRequestActivityState,
  identity: PullRequestActivityIdentity,
): PullRequestActivityState {
  const key = getActivityStateKey(identity);
  if (state.hiddenKeys.includes(key)) {
    return state;
  }
  return { ...state, hiddenKeys: [...state.hiddenKeys, key] };
}

export function showHiddenActivities(
  state: PullRequestActivityState,
  input: { prNumber: number },
): PullRequestActivityState {
  const prefix = `${input.prNumber}:`;
  return { ...state, hiddenKeys: state.hiddenKeys.filter((key) => !key.startsWith(prefix)) };
}

export function getVisibleEntries(
  state: PullRequestActivityState,
  input: { prNumber: number; entries: readonly PrTimelineEntry[] },
): VisiblePullRequestEntry[] {
  return input.entries.flatMap((entry) => {
    const key = getActivityStateKey({ prNumber: input.prNumber, activityId: entry.id });
    if (state.hiddenKeys.includes(key)) {
      return [];
    }
    return [{ entry, collapsed: state.collapsedKeys.includes(key) }];
  });
}

export function hasHiddenActivities(
  state: PullRequestActivityState,
  input: { prNumber: number },
): boolean {
  const prefix = `${input.prNumber}:`;
  return state.hiddenKeys.some((key) => key.startsWith(prefix));
}
