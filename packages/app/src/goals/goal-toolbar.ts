import type { GoalListFilter } from "./goal-attention";
import {
  DEFAULT_GOAL_SORT,
  GOAL_PRIORITY_FILTER_ALL,
  type GoalPriorityFilter,
  type GoalSort,
} from "./goal-management";
import { GOAL_PROJECT_FILTER_ALL } from "./goal-projects";

/** The status filter the list opens with. */
export const DEFAULT_GOAL_LIST_FILTER: GoalListFilter = "all";

/** The count a badge shows before it saturates, so the badge never outgrows its button. */
const BADGE_MAX = 99;

export interface GoalToolbarState {
  status: GoalListFilter;
  project: string;
  priority: GoalPriorityFilter;
  sort: GoalSort;
}

export type GoalToolbarControl = keyof GoalToolbarState;

/** Which toolbar controls differ from their default, and so show as active. */
export function activeGoalToolbarControls(
  state: GoalToolbarState,
): Record<GoalToolbarControl, boolean> {
  return {
    status: state.status !== DEFAULT_GOAL_LIST_FILTER,
    project: state.project !== GOAL_PROJECT_FILTER_ALL,
    priority: state.priority !== GOAL_PRIORITY_FILTER_ALL,
    // Sort is remembered on the device; only an order other than the default counts as active.
    sort: state.sort !== DEFAULT_GOAL_SORT,
  };
}

/** The badge text for a count, or null when there is nothing to show. */
export function goalToolbarBadgeText(count: number): string | null {
  if (count <= 0) {
    return null;
  }
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

export type GoalToolbarMark = { kind: "badge"; text: string } | { kind: "dot" } | { kind: "none" };

/**
 * What an icon button carries besides its icon. A count that asks for attention always shows,
 * active or not; otherwise an active control shows a dot.
 */
export function goalToolbarMark({
  active,
  attentionCount = 0,
}: {
  active: boolean;
  attentionCount?: number;
}): GoalToolbarMark {
  const text = goalToolbarBadgeText(attentionCount);
  if (text) {
    return { kind: "badge", text };
  }
  return active ? { kind: "dot" } : { kind: "none" };
}
