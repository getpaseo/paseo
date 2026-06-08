import type { PrPaneActivity } from "./data";

export interface PullRequestActivityIdentity {
  prNumber: number;
  activityId: string;
}

export interface PullRequestActivityState {
  collapsedKeys: readonly string[];
  hiddenKeys: readonly string[];
}

export interface VisiblePullRequestActivity {
  activity: PrPaneActivity;
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

export function getVisibleActivities(
  state: PullRequestActivityState,
  input: { prNumber: number; activities: readonly PrPaneActivity[] },
): VisiblePullRequestActivity[] {
  return input.activities.flatMap((activity) => {
    const key = getActivityStateKey({ prNumber: input.prNumber, activityId: activity.id });
    if (state.hiddenKeys.includes(key)) {
      return [];
    }
    return [{ activity, collapsed: state.collapsedKeys.includes(key) }];
  });
}

export function hasHiddenActivities(
  state: PullRequestActivityState,
  input: { prNumber: number },
): boolean {
  const prefix = `${input.prNumber}:`;
  return state.hiddenKeys.some((key) => key.startsWith(prefix));
}
