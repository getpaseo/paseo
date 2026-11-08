import {
  acceptNoteProblem,
  canAcceptGoal,
  criteriaToWaive,
} from "@getpaseo/protocol/goal/acceptance";
import type { AcceptanceCriterion, Goal } from "@getpaseo/protocol/goal/types";

/** Accept as is shows on a host with `goalAccept`, for a goal the daemon would accept. */
export function canAccept(goal: Goal, hasFeature: boolean): boolean {
  return hasFeature && canAcceptGoal(goal);
}

export interface AcceptGroup {
  kind: "notMet" | "neverChecked";
  criteria: AcceptanceCriterion[];
}

/**
 * The criteria an accept waives, by why they are unverified. An empty group is left out. All
 * unverified criteria share one group: the verifier answers every criterion it is asked, or the
 * verification fails as a whole (server `review.ts` `parseVerification`), so one run never leaves
 * some judged unmet and others unchecked.
 */
export function acceptGroups(goal: Goal): AcceptGroup[] {
  const { notMet, neverChecked } = criteriaToWaive(goal);
  const groups: AcceptGroup[] = [
    { kind: "notMet", criteria: notMet },
    { kind: "neverChecked", criteria: neverChecked },
  ];
  return groups.filter((group) => group.criteria.length > 0);
}

/** Every criterion the accept sends: the daemon refuses anything but all the unverified ones. */
export function acceptCriterionIds(goal: Goal): string[] {
  const { notMet, neverChecked } = criteriaToWaive(goal);
  return [...notMet, ...neverChecked].map((criterion) => criterion.id);
}

/**
 * Whether Confirm can send the note, and the error to show under the field. An empty note
 * disables Confirm without an error; a note over the limit says so.
 */
export function acceptNoteState(note: string): { canConfirm: boolean; tooLong: boolean } {
  const problem = acceptNoteProblem(note);
  return { canConfirm: problem === null, tooLong: problem === "too_long" };
}

/** How many criteria an accepted goal waived, or null when the goal was not accepted. */
export function acceptedWaivedCount(goal: Pick<Goal, "accepted" | "criteria">): number | null {
  if (!goal.accepted) {
    return null;
  }
  return goal.criteria.filter((criterion) => criterion.waived).length;
}

/** A criterion's badge: verified, waived by an accept, or still unverified. */
export function criterionState(
  criterion: Pick<AcceptanceCriterion, "verifiedAt" | "waived">,
): "verified" | "waived" | "unverified" {
  if (criterion.verifiedAt) {
    return "verified";
  }
  return criterion.waived ? "waived" : "unverified";
}
