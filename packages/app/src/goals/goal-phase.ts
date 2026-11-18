import type { Goal } from "@getpaseo/protocol/goal/types";
import { describeGoalWaitingOn, type GoalWaitingOnKind } from "@getpaseo/protocol/goal/waiting-on";
import { liveRecovery } from "./goal-recovery";

/** Where a goal stands, in the words the detail screen explains it with. */
export type GoalPhase =
  | "manual"
  | "planning"
  | "plan_review"
  | "paused"
  | "working"
  | "change_review"
  | "reviewing"
  | "integrating"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type GoalStepId = "planning" | "plan_review" | "working" | "review" | "integrating" | "done";

export const GOAL_STEP_IDS: readonly GoalStepId[] = [
  "planning",
  "plan_review",
  "working",
  "review",
  "integrating",
  "done",
];

export type GoalStepState = "done" | "current" | "upcoming" | "stopped";

export interface GoalStep {
  id: GoalStepId;
  state: GoalStepState;
}

const PHASE_OF_WAITING: Record<GoalWaitingOnKind, GoalPhase> = {
  paused: "paused",
  planning: "planning",
  plan_approval: "plan_review",
  change_set_approval: "change_review",
  // The plan already runs; a revision waiting for approval does not send the goal back a step.
  plan_revision_approval: "working",
  lead_decision: "working",
  running: "working",
  review: "reviewing",
  merge: "integrating",
  retry: "working",
  verification: "verifying",
  manual: "manual",
};

/** Where the work of a goal stands, from the protocol's shared reading of its state. */
function workPhase(goal: Goal): GoalPhase {
  // Ended goals are read as if still running, to find the step they stopped at.
  const waiting = describeGoalWaitingOn({ ...goal, status: "executing", pausedAt: null });
  return waiting ? PHASE_OF_WAITING[waiting.kind] : "verifying";
}

export function goalPhase(goal: Goal): GoalPhase {
  switch (goal.status) {
    case "completed":
    case "failed":
    case "cancelled":
      return goal.status;
    case "planning":
      return goal.config ? "planning" : "manual";
    case "awaiting_plan_approval":
      return "plan_review";
    case "executing":
      if (!goal.config) {
        return "manual";
      }
      return goal.pausedAt ? "paused" : workPhase(goal);
  }
}

const STEP_OF_PHASE: Record<GoalPhase, number> = {
  manual: 0,
  planning: 0,
  plan_review: 1,
  paused: 2,
  working: 2,
  change_review: 3,
  reviewing: 3,
  integrating: 4,
  verifying: 4,
  completed: 5,
  failed: 0,
  cancelled: 0,
};

/** The step an ended goal stopped at, read from how far its work got. */
function stoppedStep(goal: Goal): number {
  if (goal.tasks.length === 0) {
    return STEP_OF_PHASE.planning;
  }
  if (goal.runs.length === 0) {
    return STEP_OF_PHASE.plan_review;
  }
  return STEP_OF_PHASE[workPhase(goal)];
}

/** The six-step stepper, or null for a manual goal, which has no pipeline to show. */
export function goalSteps(goal: Goal): GoalStep[] | null {
  if (!goal.config) {
    return null;
  }
  if (goal.status === "completed") {
    return GOAL_STEP_IDS.map((id) => ({ id, state: "done" }));
  }
  const isEnded = goal.status === "failed" || goal.status === "cancelled";
  const reached = isEnded ? stoppedStep(goal) : STEP_OF_PHASE[goalPhase(goal)];
  return GOAL_STEP_IDS.map((id, index) => {
    if (index < reached) {
      return { id, state: "done" };
    }
    if (index === reached) {
      return { id, state: isEnded ? "stopped" : "current" };
    }
    return { id, state: "upcoming" };
  });
}

export type GoalGuidanceTone = "default" | "info" | "success" | "warning" | "error";

const TONE_OF_PHASE: Record<GoalPhase, GoalGuidanceTone> = {
  manual: "default",
  planning: "info",
  plan_review: "warning",
  paused: "default",
  working: "info",
  change_review: "warning",
  reviewing: "info",
  integrating: "info",
  verifying: "info",
  completed: "success",
  failed: "error",
  cancelled: "default",
};

export interface GoalGuidance {
  phase: GoalPhase;
  tone: GoalGuidanceTone;
  /** Interpolation values for the phase's sentence. */
  params: { running: number; total: number; held: number; branch: string };
}

/** What is happening and what, if anything, you need to do. */
export function goalGuidance(goal: Goal): GoalGuidance {
  const phase = goalPhase(goal);
  return {
    phase,
    tone: TONE_OF_PHASE[phase],
    params: {
      running: goal.tasks.filter((task) => task.status === "running").length,
      total: goal.tasks.length,
      held: goal.changeSets.filter((changeSet) => changeSet.status === "awaiting_human").length,
      branch: goal.integration?.branch ?? `paseo-goal/${goal.id}`,
    },
  };
}

/**
 * The goal failed because an agent asked for a permission or asked a question. The daemon
 * names the turn outcome `needs_permission` in the reason when the Lead or a task stops on it
 * ("Lead agent did not finish planning (needs_permission).", "Task a stopped on a request
 * (needs_permission): ...", goal-manager.ts); that identifier is the stable part of the text.
 */
export function goalFailedOnPermission(goal: Pick<Goal, "status" | "failureReason">): boolean {
  return goal.status === "failed" && (goal.failureReason ?? "").includes("needs_permission");
}

/** Of those, one where the agent asked a question; the daemon quotes it in the reason. */
export function goalFailedOnQuestion(goal: Pick<Goal, "status" | "failureReason">): boolean {
  return (
    goalFailedOnPermission(goal) && (goal.failureReason ?? "").includes("Agent asked a question")
  );
}

/** The daemon refuses more plan rejections than this (docs/goals.md "Control a running goal"). */
export const MAX_PLAN_REJECTIONS = 5;

export interface GoalControls {
  canRejectPlan: boolean;
  canPause: boolean;
  canResume: boolean;
  /** Retry every failed task, reopening the failed goal. */
  canRetry: boolean;
  /** The retry reopens a goal that failed while planning: a fresh Lead plans again. */
  canRetryPlanning: boolean;
  /** The retry merges again change sets whose merge failed (`goalIntegrationRetry`). */
  canRetryMerge: boolean;
  /** Retry one failed or cancelled task of a live goal. */
  canRetryTasks: boolean;
}

const NO_CONTROLS: GoalControls = {
  canRejectPlan: false,
  canPause: false,
  canResume: false,
  canRetry: false,
  canRetryPlanning: false,
  canRetryMerge: false,
  canRetryTasks: false,
};

/** The translation key that labels the retry: planning, merge, or the failed tasks. */
export function goalRetryLabelKey(
  controls: Pick<GoalControls, "canRetryPlanning" | "canRetryMerge">,
): "goals.detail.retryPlanning" | "goals.detail.retryMerge" | "goals.detail.retryGoal" {
  if (controls.canRetryPlanning) return "goals.detail.retryPlanning";
  if (controls.canRetryMerge) return "goals.detail.retryMerge";
  return "goals.detail.retryGoal";
}

/**
 * A rejected change set whose merge step failed after review and approval. A host with
 * `goalIntegrationRetry` merges it again on retry; one rejected by review stays rejected.
 */
export function isIntegrationFailedChangeSet(changeSet: Goal["changeSets"][number]): boolean {
  return changeSet.status === "rejected" && changeSet.rejectionReason === "integration_failed";
}

/**
 * A rejected change set whose rework task failed for good. A host with `goalReworkRetry` reworks
 * it again when a retry or recovery reopens the goal.
 */
export function isReworkFailedChangeSet(changeSet: Goal["changeSets"][number]): boolean {
  return changeSet.status === "rejected" && changeSet.rejectionReason === "rework_failed";
}

/**
 * Which controls to offer: only on hosts with goal controls, only for managed goals, and only in
 * the states the daemon accepts them in. A goal that failed while planning has no tasks; only a
 * host with `goalConfigEdit` reopens it, an older one refuses the retry. A change set rejected
 * by review keeps a failed goal from reopening; one whose merge failed does not on a host with
 * `goalIntegrationRetry`, which merges it again, nor one whose rework failed on a host with
 * `goalReworkRetry`, which reworks it again.
 */
export function goalControlsAvailable(
  goal: Goal,
  hostHasControls: boolean,
  host: { configEdit?: boolean; integrationRetry?: boolean; reworkRetry?: boolean } = {},
): GoalControls {
  if (!hostHasControls || !goal.config) {
    return NO_CONTROLS;
  }
  const isLive =
    goal.status !== "completed" && goal.status !== "failed" && goal.status !== "cancelled";
  const rejections = goal.planRejections?.length ?? 0;
  const remergeable = (changeSet: Goal["changeSets"][number]) =>
    host.integrationRetry === true && isIntegrationFailedChangeSet(changeSet);
  const reworkable = (changeSet: Goal["changeSets"][number]) =>
    host.reworkRetry === true && isReworkFailedChangeSet(changeSet);
  const hasRejectedChange = goal.changeSets.some(
    (changeSet) =>
      changeSet.status === "rejected" && !remergeable(changeSet) && !reworkable(changeSet),
  );
  // The daemon reopens an archived failed goal only after it is unarchived, and refuses a retry
  // while a recovery is open.
  const retryable =
    goal.status === "failed" && !hasRejectedChange && !goal.archivedAt && !liveRecovery(goal);
  const failedPlanning = goal.tasks.length === 0;
  return {
    canRejectPlan: goal.status === "awaiting_plan_approval" && rejections < MAX_PLAN_REJECTIONS,
    canPause: isLive && !goal.pausedAt,
    canResume: isLive && Boolean(goal.pausedAt),
    canRetry: retryable && (!failedPlanning || host.configEdit === true),
    canRetryPlanning: retryable && failedPlanning && host.configEdit === true,
    canRetryMerge: retryable && goal.changeSets.some(remergeable),
    canRetryTasks: goal.status === "executing",
  };
}
