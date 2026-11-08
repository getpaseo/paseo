import type { Goal, GoalSummary } from "@getpaseo/protocol/goal/types";

/**
 * The cached list with one pushed goal applied. A push older than the cached copy (a lower
 * `lastSeq`) is dropped, so a late push cannot move a goal backwards.
 */
export function applyGoalUpdate(goals: readonly GoalSummary[], update: GoalSummary): GoalSummary[] {
  const index = goals.findIndex((goal) => goal.id === update.id);
  if (index === -1) {
    return [update, ...goals];
  }
  const current = goals[index];
  if (current && current.lastSeq > update.lastSeq) {
    return goals.slice();
  }
  const next = goals.slice();
  next[index] = update;
  return next;
}

/**
 * A polled list merged with what the cache already holds. A poll that left before a push
 * arrived carries the older state; the newer cached goal wins.
 */
export function mergePolledGoals(
  cached: readonly GoalSummary[] | undefined,
  polled: readonly GoalSummary[],
): GoalSummary[] {
  if (!cached || cached.length === 0) {
    return polled.slice();
  }
  const newer = new Map(cached.map((goal) => [goal.id, goal]));
  return polled.map((goal) => {
    const held = newer.get(goal.id);
    return held && held.lastSeq > goal.lastSeq ? held : goal;
  });
}

/** Which goals a cached list holds: the default list leaves archived goals out. */
export type GoalListArchivedMode = "exclude" | "include";

/**
 * The cached list with one pushed goal applied. A deleted goal leaves every list; an archived
 * one leaves a list that hides archived goals, unless the cache holds a newer state of it.
 */
export function applyGoalPush(
  goals: readonly GoalSummary[],
  update: GoalSummary,
  options: { deleted: boolean; archived: GoalListArchivedMode },
): GoalSummary[] {
  if (options.deleted) {
    return removeGoalFromList(goals, update.id);
  }
  const current = goals.find((goal) => goal.id === update.id);
  if (current && current.lastSeq > update.lastSeq) {
    return goals.slice();
  }
  if (update.archivedAt && options.archived === "exclude") {
    return removeGoalFromList(goals, update.id);
  }
  return applyGoalUpdate(goals, update);
}

export function removeGoalFromList(goals: readonly GoalSummary[], goalId: string): GoalSummary[] {
  return goals.filter((goal) => goal.id !== goalId);
}

/**
 * A goal a mutation returned, merged into the cached list it is already in. The response has
 * no `progress`, so the cached counts stay until the next poll or push. A goal the list does not
 * hold is left out: the next fetch decides whether it belongs.
 */
export function replaceGoalInList<T extends GoalSummary>(
  goals: readonly T[],
  goal: Goal,
  options: { archived: GoalListArchivedMode },
): T[] {
  if (goal.archivedAt && options.archived === "exclude") {
    return goals.filter((entry) => entry.id !== goal.id);
  }
  return goals.map((entry) =>
    entry.id === goal.id && entry.lastSeq <= goal.lastSeq ? { ...entry, ...goal } : entry,
  );
}
