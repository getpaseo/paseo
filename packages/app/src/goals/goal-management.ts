import type { Goal, GoalPriority } from "@getpaseo/protocol/goal/types";
import { canAcknowledgeGoal } from "./goal-attention";
import { isGoalTerminal } from "./goal-derivation";
import { goalControlsAvailable } from "./goal-phase";
import { describeGoalProject, type GoalProjectOption } from "./goal-projects";
import { liveRecovery } from "./goal-recovery";

export const GOAL_PRIORITIES: readonly GoalPriority[] = ["high", "normal", "low"];

/** A goal without a priority is normal, as the daemon reads it. */
export function goalPriority(goal: Pick<Goal, "priority">): GoalPriority {
  return goal.priority ?? "normal";
}

const PRIORITY_RANK: Record<GoalPriority, number> = { high: 2, normal: 1, low: 0 };

export function isGoalArchived(goal: Pick<Goal, "archivedAt">): boolean {
  return Boolean(goal.archivedAt);
}

export const GOAL_SORTS = ["priority", "updated", "newest", "name"] as const;

export type GoalSort = (typeof GOAL_SORTS)[number];

export const DEFAULT_GOAL_SORT: GoalSort = "priority";

type SortInput = Pick<Goal, "id" | "title" | "priority" | "createdAt" | "updatedAt">;

function byRecentUpdate(a: SortInput, b: SortInput): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/**
 * Orders goals for the list. Priority puts higher priority first, then the most recently
 * updated; the others fall back to the id so the order never flickers between polls.
 */
export function compareGoals(sort: GoalSort): (a: SortInput, b: SortInput) => number {
  return (a, b) => {
    let result = 0;
    switch (sort) {
      case "priority":
        result =
          PRIORITY_RANK[goalPriority(b)] - PRIORITY_RANK[goalPriority(a)] || byRecentUpdate(a, b);
        break;
      case "updated":
        result = byRecentUpdate(a, b);
        break;
      case "newest":
        result = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        break;
      case "name":
        result = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        break;
    }
    return result || a.id.localeCompare(b.id);
  };
}

/** Case-insensitive substring of the title, objective, id or the name of the goal's project. */
export function matchesGoalSearch(
  goal: Pick<Goal, "id" | "title" | "objective" | "config">,
  query: string,
  projects: readonly GoalProjectOption[],
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const projectName = describeGoalProject(projects, goal.config?.cwd)?.name ?? "";
  return [goal.title, goal.objective, goal.id, projectName].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

export const GOAL_PRIORITY_FILTER_ALL = "all";
export type GoalPriorityFilter = GoalPriority | typeof GOAL_PRIORITY_FILTER_ALL;

export interface GoalViewFilters {
  search: string;
  priority: GoalPriorityFilter;
  /** Archived goals are left out unless this is on. */
  showArchived: boolean;
}

/** Search, priority and the archived toggle; the status and project filters live elsewhere. */
export function filterGoalsForView<
  T extends Pick<Goal, "id" | "title" | "objective" | "config" | "priority" | "archivedAt">,
>(goals: readonly T[], filters: GoalViewFilters, projects: readonly GoalProjectOption[]): T[] {
  return goals.filter(
    (goal) =>
      (filters.showArchived || !isGoalArchived(goal)) &&
      (filters.priority === GOAL_PRIORITY_FILTER_ALL || goalPriority(goal) === filters.priority) &&
      matchesGoalSearch(goal, filters.search, projects),
  );
}

/** Whether a filter beyond the status chips narrows the list, so "Clear filters" has work to do. */
export function hasNarrowingGoalFilters(input: {
  search: string;
  priority: GoalPriorityFilter;
  projectFiltered: boolean;
}): boolean {
  return (
    input.search.trim().length > 0 ||
    input.priority !== GOAL_PRIORITY_FILTER_ALL ||
    input.projectFiltered
  );
}

/** The host flags that decide which actions a goal can offer. */
export interface GoalActionFeatures {
  /** `goalControls`: pause, resume, retry. */
  controls: boolean;
  /** `goalAcknowledge`: dismiss. */
  acknowledge: boolean;
  /** `goalManagement`: rename, priority, archive, unarchive, delete. */
  management: boolean;
  /** `goalConfigEdit`: settings changes and reopening a goal that failed while planning. */
  configEdit: boolean;
  /** `goalIntegrationRetry`: retry merges again change sets whose merge failed. */
  integrationRetry: boolean;
  /** `goalReworkRetry`: retry reworks again change sets whose rework failed. */
  reworkRetry: boolean;
}

export interface GoalActions {
  pause: boolean;
  resume: boolean;
  /** Cancel: the stop. Final, and needed before a live goal can be archived or deleted. */
  cancel: boolean;
  retry: boolean;
  /** The retry reopens a goal that failed while planning; label it so. */
  retryPlanning: boolean;
  /** The retry merges again change sets whose merge failed; label it so. */
  retryMerge: boolean;
  /** Change the settings of a managed goal that is not archived. */
  editSettings: boolean;
  rename: boolean;
  priority: boolean;
  archive: boolean;
  unarchive: boolean;
  delete: boolean;
  dismiss: boolean;
}

/**
 * The actions the daemon accepts for a goal in its current state. Rename and priority work in
 * any state; archive and delete only on an ended goal; a failed goal must be unarchived before a
 * retry can reopen it.
 */
export function goalAvailableActions(goal: Goal, features: GoalActionFeatures): GoalActions {
  const controls = goalControlsAvailable(goal, features.controls, {
    configEdit: features.configEdit,
    integrationRetry: features.integrationRetry,
    reworkRetry: features.reworkRetry,
  });
  const ended = isGoalTerminal(goal.status);
  const archived = isGoalArchived(goal);
  // A failed goal under recovery is ended but not settled: archive and delete wait for it.
  const recovering = liveRecovery(goal) !== null;
  return {
    pause: controls.canPause,
    resume: controls.canResume,
    cancel: !ended,
    retry: controls.canRetry,
    retryPlanning: controls.canRetryPlanning,
    retryMerge: controls.canRetryMerge,
    editSettings: features.configEdit && goal.config !== null && !archived,
    rename: features.management,
    priority: features.management,
    archive: features.management && ended && !archived && !recovering,
    unarchive: features.management && archived,
    delete: features.management && ended && !recovering,
    dismiss: features.acknowledge && canAcknowledgeGoal(goal),
  };
}

export function hasAnyGoalAction(actions: GoalActions): boolean {
  return Object.values(actions).some(Boolean);
}
