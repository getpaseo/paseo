/**
 * Accepting a failed goal as is (goal.accepted): when it is possible and what it waives. The
 * daemon's reducer is the authority; the app and the CLI use these to offer the action and to
 * show the person what they are about to waive.
 */
import { diagnoseGoalFailure } from "./diagnosis.js";
import { isCriteriaNotMetFailure } from "./failure-wording.js";
import { liveRecovery } from "./recovery-state.js";
import type { AcceptanceCriterion, Goal } from "./types.js";
import { MAX_ACCEPT_NOTE_CHARS } from "./types.js";

/**
 * Why the goal cannot be accepted as is now, or null when it can: a failed managed goal, not
 * archived, with no recovery open, whose tasks all succeeded and whose work was all captured and
 * merged. The reducer refuses goal.accepted with this same check.
 */
export function acceptRefusal(goal: Goal): string | null {
  if (goal.status !== "failed") return `the goal is ${goal.status}; only a failed goal`;
  if (!goal.config) return "a manual goal cannot be accepted";
  if (goal.archivedAt) return "the goal is archived; unarchive it first";
  const live = liveRecovery(goal);
  if (live) return `recovery ${live.id} is still ${live.status}; cancel it first`;
  if (goal.tasks.length === 0) return "the goal failed before it had a plan; nothing was built";
  const open = goal.tasks.filter((t) => t.status !== "succeeded");
  if (open.length > 0) return `tasks not succeeded: ${open.map((t) => t.id).join(", ")}`;
  const uncaptured = goal.tasks.filter((t) => t.kind === "implement" && !t.captured);
  if (uncaptured.length > 0) {
    return `work not captured for: ${uncaptured.map((t) => t.id).join(", ")}`;
  }
  const unmerged = goal.changeSets.filter(
    (c) => c.status !== "integrated" && c.status !== "superseded",
  );
  if (unmerged.length > 0) return `change sets not merged: ${unmerged.map((c) => c.id).join(", ")}`;
  return null;
}

export function canAcceptGoal(goal: Goal): boolean {
  return acceptRefusal(goal) === null;
}

/**
 * The criteria an accept waives: every one still unverified. `notMet` when the verifier judged
 * them and found them unmet; `neverChecked` when verification did not finish (it gave no usable
 * answer, or time ran out). The goal's own reason is read through the diagnosis, since a
 * recovery that ended for a person rewrites it.
 */
export interface WaivedCriteria {
  notMet: AcceptanceCriterion[];
  neverChecked: AcceptanceCriterion[];
}

/**
 * The failure the goal stopped with: its own reason, or the one a recovery that ended for a
 * person replaced (see the diagnosis). goal.accepted records it as `acceptedFrom`.
 */
export function originalFailureReason(goal: Goal): string | null {
  if (goal.status !== "failed") return goal.failureReason;
  const { failureReason } = diagnoseGoalFailure(goal, { now: Date.parse(goal.updatedAt) });
  return failureReason ?? goal.failureReason;
}

export function criteriaToWaive(goal: Goal): WaivedCriteria {
  const unverified = goal.criteria.filter((c) => !c.verifiedAt);
  // One group for all: the verifier answers every criterion it is asked or the verification
  // fails as a whole (review.ts), so after a "not met" failure every unverified criterion was
  // judged unmet, and after any other failure none was judged (review.ts parseVerification).
  return isCriteriaNotMetFailure(originalFailureReason(goal))
    ? { notMet: unverified, neverChecked: [] }
    : { notMet: [], neverChecked: unverified };
}

/** The criteria an accepted goal waived, in the goal's order. */
export function waivedCriteria(goal: Goal): AcceptanceCriterion[] {
  return goal.criteria.filter((c) => c.waived);
}

/** Why a note cannot be sent, or null. The daemon trims it and checks the same. */
export function acceptNoteProblem(note: string): "empty" | "too_long" | null {
  const trimmed = note.trim();
  if (trimmed.length === 0) return "empty";
  if (trimmed.length > MAX_ACCEPT_NOTE_CHARS) return "too_long";
  return null;
}
