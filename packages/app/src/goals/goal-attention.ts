import type { Goal, GoalStatus } from "@getpaseo/protocol/goal/types";
import { pendingPlanRevision } from "./goal-plan-revisions";
import { endedRecovery, liveRecovery } from "./goal-recovery";

/**
 * Why a goal is waiting on you. A plan, a change, a plan change or a recovery's plan change to
 * approve blocks it; a failure only reports.
 */
export type GoalAttentionKind =
  | "plan_review"
  | "change_review"
  | "revision_review"
  | "recovery_review"
  | "failed";

export type GoalListFilter = "needs_you" | "running" | "done" | "all";

export const GOAL_LIST_FILTERS: readonly GoalListFilter[] = ["needs_you", "running", "done", "all"];

type AttentionInput = Pick<
  Goal,
  | "status"
  | "changeSets"
  | "acknowledgedAt"
  | "archivedAt"
  | "planRevisions"
  | "recovery"
  | "failedAt"
>;

const DONE_STATUSES: ReadonlySet<GoalStatus> = new Set(["completed", "failed", "cancelled"]);

function awaitingChangeSetIds(goal: AttentionInput): string[] {
  return goal.changeSets
    .filter((changeSet) => changeSet.status === "awaiting_human")
    .map((changeSet) => changeSet.id);
}

export function goalAttention(goal: AttentionInput): GoalAttentionKind | null {
  // Archiving puts an ended goal away; it stops asking like a dismissed one.
  if (goal.archivedAt) {
    return null;
  }
  if (goal.status === "awaiting_plan_approval") {
    return "plan_review";
  }
  if (goal.status === "failed") {
    const recovery = liveRecovery(goal);
    if (recovery) {
      // The Lead's plan change waits for you; while it decides or applies, nothing does.
      return recovery.status === "awaiting_approval" ? "recovery_review" : null;
    }
    // A dismissed failure stops asking; a retry that reopens the goal clears the mark. A
    // recovery that ended after the dismiss is a new failure, so it asks again.
    return goal.acknowledgedAt && !endedAfter(goal, goal.acknowledgedAt) ? null : "failed";
  }
  if (goal.status === "executing" && awaitingChangeSetIds(goal).length > 0) {
    return "change_review";
  }
  if (goal.status === "executing" && pendingPlanRevision(goal)) {
    return "revision_review";
  }
  return null;
}

/** The goal's current failure is a recovery that ended after `at`. */
function endedAfter(goal: AttentionInput, at: string): boolean {
  const resolvedAt = endedRecovery(goal)?.resolvedAt;
  return resolvedAt !== undefined && Date.parse(resolvedAt) > Date.parse(at);
}

/**
 * An ended goal that has not been dismissed yet; the daemon refuses to acknowledge a live one.
 * A failed goal under recovery is not settled, so it is not offered either.
 */
export function canAcknowledgeGoal(
  goal: Pick<Goal, "status" | "acknowledgedAt" | "recovery">,
): boolean {
  return DONE_STATUSES.has(goal.status) && !goal.acknowledgedAt && !liveRecovery(goal);
}

/** Plans and changes held for your approval. Failures are listed, but do not count here. */
export function isBlockedOnUser(kind: GoalAttentionKind | null): boolean {
  return kind !== null && kind !== "failed";
}

export function countGoalsBlockedOnUser(goals: readonly AttentionInput[]): number {
  return goals.filter((goal) => isBlockedOnUser(goalAttention(goal))).length;
}

export function matchesGoalListFilter(goal: AttentionInput, filter: GoalListFilter): boolean {
  switch (filter) {
    case "needs_you":
      return goalAttention(goal) !== null;
    // A failed goal under recovery is running work again: a Lead decides how it goes on.
    case "running":
      return !DONE_STATUSES.has(goal.status) || liveRecovery(goal) !== null;
    case "done":
      return DONE_STATUSES.has(goal.status) && liveRecovery(goal) === null;
    case "all":
      return true;
  }
}

export function countGoalsByFilter(
  goals: readonly AttentionInput[],
): Record<GoalListFilter, number> {
  const counts: Record<GoalListFilter, number> = { needs_you: 0, running: 0, done: 0, all: 0 };
  for (const goal of goals) {
    for (const filter of GOAL_LIST_FILTERS) {
      if (matchesGoalListFilter(goal, filter)) {
        counts[filter] += 1;
      }
    }
  }
  return counts;
}

export interface GoalListSections<T> {
  /** Goals waiting on you. */
  attention: T[];
  others: T[];
  /** Archived goals, present only when the list shows them. */
  archived: T[];
}

const byRecentUpdate = (a: Pick<Goal, "updatedAt">, b: Pick<Goal, "updatedAt">) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/**
 * The goals the filter keeps, split into the ones waiting on you, the rest, and the archived
 * ones, each in `compare` order (newest activity first by default).
 */
export function buildGoalListSections<T extends AttentionInput & Pick<Goal, "updatedAt">>(
  goals: readonly T[],
  filter: GoalListFilter,
  compare: (a: T, b: T) => number = byRecentUpdate,
): GoalListSections<T> {
  const sorted = goals.filter((goal) => matchesGoalListFilter(goal, filter)).sort(compare);
  const live = sorted.filter((goal) => !goal.archivedAt);
  return {
    attention: live.filter((goal) => goalAttention(goal) !== null),
    others: live.filter((goal) => goalAttention(goal) === null),
    archived: sorted.filter((goal) => Boolean(goal.archivedAt)),
  };
}

interface GoalAttentionMark {
  kind: GoalAttentionKind | null;
  changeSetIds: readonly string[];
  /** The plan change or recovery waiting for approval, so a later one is reported too. */
  approvalId: string | null;
}

function approvalId(goal: AttentionInput): string | null {
  return pendingPlanRevision(goal)?.id ?? liveRecovery(goal)?.id ?? null;
}

/** What each goal was waiting on at one poll, compared with the next by `findNewGoalAttention`. */
export type GoalAttentionSnapshot = ReadonlyMap<string, GoalAttentionMark>;

export function snapshotGoalAttention(
  goals: readonly (AttentionInput & Pick<Goal, "id">)[],
): GoalAttentionSnapshot {
  return new Map(
    goals.map((goal) => [
      goal.id,
      {
        kind: goalAttention(goal),
        changeSetIds: awaitingChangeSetIds(goal),
        approvalId: approvalId(goal),
      },
    ]),
  );
}

export interface GoalAttentionTransition<T> {
  goal: T;
  kind: GoalAttentionKind;
}

/**
 * Goals that started waiting on you since the previous poll: a new state, another change set
 * held for approval, or another plan change. Without a previous poll nothing is new, so opening
 * the app is quiet.
 */
export function findNewGoalAttention<T extends AttentionInput & Pick<Goal, "id">>(
  previous: GoalAttentionSnapshot | null,
  goals: readonly T[],
): GoalAttentionTransition<T>[] {
  if (!previous) {
    return [];
  }
  const transitions: GoalAttentionTransition<T>[] = [];
  for (const goal of goals) {
    const kind = goalAttention(goal);
    if (!kind) {
      continue;
    }
    const before = previous.get(goal.id);
    const isNewKind = before?.kind !== kind;
    const hasNewChangeSet =
      kind === "change_review" &&
      awaitingChangeSetIds(goal).some((id) => !before?.changeSetIds.includes(id));
    const hasNewApproval =
      (kind === "revision_review" || kind === "recovery_review") &&
      approvalId(goal) !== (before?.approvalId ?? null);
    if (isNewKind || hasNewChangeSet || hasNewApproval) {
      transitions.push({ goal, kind });
    }
  }
  return transitions;
}
