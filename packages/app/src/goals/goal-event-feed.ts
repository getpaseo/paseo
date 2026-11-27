import {
  FAILURE_TRIGGERS as FAILURE_TRIGGER_LIST,
  interventionClass,
} from "@getpaseo/protocol/goal/interventions";
import type { ChangeSetStatus, Goal, GoalEvent } from "@getpaseo/protocol/goal/types";

export type GoalFeedTone = "default" | "success" | "warning" | "error";

/** One line of the activity feed. `key` names a sentence under `goals.events`. */
export interface GoalFeedEntry {
  id: string;
  key: string;
  tone: GoalFeedTone;
  /** What the sentence is about: task titles, a reason, a provider. Several when collapsed. */
  subjects: string[];
  detail: string | null;
  count: number;
  /** The verification round of a criterion verified after a recovery added work; null otherwise. */
  round: number | null;
  /** The newest event folded into this line. */
  at: string;
  events: GoalEvent[];
}

type FeedGoal = Pick<Goal, "tasks" | "runs" | "changeSets" | "criteria" | "interventions">;

interface Described {
  key: string;
  tone: GoalFeedTone;
  subject: string | null;
  detail?: string | null;
  round?: number;
}

type CriterionVerified = Extract<GoalEvent, { type: "criterion.verified" }>;

/**
 * The round a criterion was verified in, from its event id: round 0 keeps
 * `<goal>:verified:<criterion>`, a later round adds `:v<round>`. The log keeps every round's
 * event, so one criterion can be verified more than once.
 */
export function verifiedRound(event: CriterionVerified): number {
  const prefix = `${event.goalId}:verified:${event.criterionId}:v`;
  if (!event.id.startsWith(prefix)) {
    return 0;
  }
  const round = Number(event.id.slice(prefix.length));
  return Number.isInteger(round) && round > 0 ? round : 0;
}

const CHANGE_SET_KEYS: Partial<Record<ChangeSetStatus, Described["key"]>> = {
  in_review: "changeSetInReview",
  awaiting_human: "changeSetAwaitingYou",
  approved: "changeSetApproved",
  integrated: "changeSetIntegrated",
  changes_requested: "changeSetChangesRequested",
  conflicted: "changeSetConflicted",
  test_failed: "changeSetTestFailed",
  rejected: "changeSetRejected",
};

const CHANGE_SET_TONES: Partial<Record<ChangeSetStatus, GoalFeedTone>> = {
  awaiting_human: "warning",
  approved: "success",
  integrated: "success",
  changes_requested: "warning",
  conflicted: "warning",
  test_failed: "error",
  rejected: "error",
};

function taskTitle(goal: FeedGoal, taskId: string): string {
  return goal.tasks.find((task) => task.id === taskId)?.title ?? taskId;
}

function runTaskTitle(goal: FeedGoal, runId: string): string {
  const run = goal.runs.find((candidate) => candidate.id === runId);
  return run ? taskTitle(goal, run.taskId) : runId;
}

function changeSetTitle(goal: FeedGoal, changeSetId: string): string {
  const changeSet = goal.changeSets.find((candidate) => candidate.id === changeSetId);
  return changeSet ? taskTitle(goal, changeSet.taskId) : changeSetId;
}

/**
 * The sentence for one event, or null for bookkeeping nobody needs to read: attachments,
 * delivered notifications, usage records, and steps another event already tells.
 */
export function describeGoalEvent(event: GoalEvent, goal: FeedGoal): Described | null {
  switch (event.type) {
    case "goal.created":
      return { key: "goalCreated", tone: "default", subject: null };
    case "lead.attached":
      return { key: "leadStarted", tone: "default", subject: null };
    case "plan.proposed":
      return { key: "planProposed", tone: "default", subject: String(event.tasks.length) };
    case "plan.approved":
      return { key: "planApproved", tone: "success", subject: null };
    case "plan.rejected":
      return { key: "planRejected", tone: "warning", subject: null, detail: event.reason || null };
    case "run.started":
      return {
        key: "taskStarted",
        tone: "default",
        subject: taskTitle(goal, event.taskId),
        detail: event.provider,
      };
    case "run.finished":
      if (event.outcome === "interrupted") {
        return { key: "runInterrupted", tone: "warning", subject: runTaskTitle(goal, event.runId) };
      }
      return null;
    case "task.succeeded":
      return { key: "taskSucceeded", tone: "success", subject: taskTitle(goal, event.taskId) };
    case "task.failed":
      return {
        key: "taskFailed",
        tone: "error",
        subject: taskTitle(goal, event.taskId),
        detail: event.error,
      };
    case "task.retried":
      return { key: "taskRetried", tone: "default", subject: taskTitle(goal, event.taskId) };
    case "task.cancelled":
      return { key: "taskCancelled", tone: "default", subject: taskTitle(goal, event.taskId) };
    case "task.added":
      return {
        key: `reworkAdded_${event.rework.reason}`,
        tone: "warning",
        subject: changeSetTitle(goal, event.rework.changeSetId),
      };
    default:
      return describeOutcomeEvent(event, goal);
  }
}

/** The second half of `describeGoalEvent`: review, merge, verification and the goal's end. */
function describeOutcomeEvent(event: GoalEvent, goal: FeedGoal): Described | null {
  switch (event.type) {
    case "criterion.verified": {
      const criterion = goal.criteria.find((candidate) => candidate.id === event.criterionId);
      const subject = criterion?.text ?? event.criterionId;
      const round = verifiedRound(event);
      if (round > 0) {
        return { key: "criterionVerifiedRound", tone: "success", subject, round };
      }
      return { key: "criterionVerified", tone: "success", subject };
    }
    case "integration.prepared":
      return { key: "integrationPrepared", tone: "default", subject: event.branch };
    case "changeset.captured":
      return {
        key: "changeSetCaptured",
        tone: "default",
        subject: taskTitle(goal, event.taskId),
      };
    case "capture.skipped":
      return { key: "captureSkipped", tone: "default", subject: taskTitle(goal, event.taskId) };
    case "changeset.transitioned": {
      const key = CHANGE_SET_KEYS[event.to];
      if (!key) {
        return null;
      }
      return {
        key,
        tone: CHANGE_SET_TONES[event.to] ?? "default",
        subject: changeSetTitle(goal, event.changeSetId),
        detail: event.findings ?? event.error ?? event.testSummary ?? null,
      };
    }
    case "changeset.integration_retried":
      return {
        key: "integrationRetried",
        tone: "default",
        subject: event.changeSetIds.map((id) => changeSetTitle(goal, id)).join(", "),
      };
    case "notification.attempted":
      if (event.outcome === "failed") {
        return {
          key: `notifyFailed_${event.target}`,
          tone: "warning",
          subject: null,
          detail: event.error ?? null,
        };
      }
      return null;
    default:
      return describeGoalEndEvent(event, goal);
  }
}

/** How the goal itself moved: ended, paused, resumed, retried, dismissed, reconfigured or reopened. */
function describeGoalEndEvent(event: GoalEvent, goal: FeedGoal): Described | null {
  switch (event.type) {
    case "goal.completed":
      return { key: "goalCompleted", tone: "success", subject: null };
    case "goal.failed":
      return { key: "goalFailed", tone: "error", subject: null, detail: event.reason };
    case "goal.cancelled":
      return { key: "goalCancelled", tone: "default", subject: null };
    case "goal.paused":
      return { key: "goalPaused", tone: "default", subject: null };
    case "goal.resumed":
      return { key: "goalResumed", tone: "default", subject: null };
    case "goal.retried":
      return {
        key: "goalRetried",
        tone: "default",
        subject: event.taskIds.map((taskId) => taskTitle(goal, taskId)).join(", "),
      };
    case "goal.acknowledged":
      return { key: "goalAcknowledged", tone: "default", subject: null };
    case "goal.config_updated":
      return { key: "goalConfigUpdated", tone: "default", subject: null };
    case "goal.reopened":
      return { key: "goalReopened", tone: "default", subject: null };
    case "goal.accepted":
      // The count reads in the sentence; the note is the detail, cut to its first sentence.
      return {
        key: "goalAccepted",
        tone: "success",
        subject: String(event.criterionIds.length),
        detail: event.note,
      };
    default:
      return describeLeadEvent(event, goal);
  }
}

const FAILURE_TRIGGERS: ReadonlySet<string> = new Set(FAILURE_TRIGGER_LIST);
const FAILURE_OUTCOMES: ReadonlySet<string> = new Set([
  "continue",
  "give_up",
  "expired",
  "lead_unavailable",
]);
const CHECK_IN_OUTCOMES: ReadonlySet<string> = new Set([
  "ok",
  "nudged",
  "stopped",
  "expired",
  "lead_unavailable",
]);
const RECOVERY_DECISIONS: ReadonlySet<string> = new Set(["retry", "revise", "needs_person"]);
const RECOVERY_OUTCOMES: ReadonlySet<string> = new Set([
  "applied",
  "rejected",
  "needs_person",
  "cancelled",
]);

/** The first line of a text, for a detail that would otherwise run long. */
function firstLine(text: string | undefined): string | null {
  const line = text?.split("\n").find((part) => part.trim().length > 0);
  return line ? line.trim() : null;
}

function optionalTaskTitle(goal: FeedGoal, taskId: string | undefined): string | null {
  return taskId ? taskTitle(goal, taskId) : null;
}

/**
 * Plan changes, the Lead's decisions about tasks and its check-ins on running ones, and
 * recoveries. Old hosts never send these events to a client that cannot read them.
 */
function describeLeadEvent(event: GoalEvent, goal: FeedGoal): Described | null {
  switch (event.type) {
    case "plan.revision_proposed":
      return {
        key: event.source === "lead" ? "revisionProposed_lead" : "revisionProposed_person",
        tone: "default",
        subject: event.ops
          .map((op) => (op.op === "remove" ? taskTitle(goal, op.taskId) : op.task.title))
          .join(", "),
        detail: event.reason || null,
      };
    case "plan.revision_approved":
      return { key: "revisionApproved", tone: "success", subject: null };
    case "plan.revision_rejected":
      return {
        key: "revisionRejected",
        tone: "warning",
        subject: null,
        detail: event.reason || null,
      };
    case "intervention.requested":
      return describeInterventionRequest(event, goal);
    case "intervention.resolved":
      return describeInterventionResolution(event, goal);
    default:
      return describeRecoveryEvent(event);
  }
}

type InterventionRequested = Extract<GoalEvent, { type: "intervention.requested" }>;
type InterventionResolved = Extract<GoalEvent, { type: "intervention.resolved" }>;

function describeInterventionRequest(
  event: InterventionRequested,
  goal: FeedGoal,
): Described | null {
  const subject = optionalTaskTitle(goal, event.taskId);
  if (!subject) {
    // A recovery's decision has no task; recovery.started tells it.
    return null;
  }
  if (interventionClass(event) === "check_in") {
    const triggers = event.triggers ?? [];
    let key = "checkInRequested";
    if (triggers.includes("near_timeout")) key = "checkInRequested_near_timeout";
    else if (triggers.includes("stall")) key = "checkInRequested_stall";
    return { key, tone: "default", subject };
  }
  return {
    key: FAILURE_TRIGGERS.has(event.trigger) ? `leadDeciding_${event.trigger}` : "leadDeciding",
    tone: "warning",
    subject,
  };
}

function describeInterventionResolution(
  event: InterventionResolved,
  goal: FeedGoal,
): Described | null {
  const intervention = goal.interventions?.find(
    (candidate) => candidate.id === event.interventionId,
  );
  const subject = optionalTaskTitle(goal, intervention?.taskId);
  const kind = intervention ? interventionClass(intervention) : null;
  if (kind === "recovery") {
    // recovery.decided tells what the recovery's Lead chose.
    return null;
  }
  if (!subject || kind === null) {
    return {
      key: "leadAnswered",
      tone: "default",
      subject: null,
      detail: event.note ?? firstLine(event.message),
    };
  }
  if (kind === "check_in") {
    const known = CHECK_IN_OUTCOMES.has(event.outcome);
    return {
      key: known ? `checkIn_${event.outcome}` : "checkIn_unknown",
      tone: event.outcome === "stopped" ? "warning" : "default",
      subject,
      detail: event.outcome === "nudged" ? firstLine(event.message) : (event.note ?? null),
    };
  }
  let tone: GoalFeedTone = "default";
  if (event.outcome === "give_up") tone = "error";
  else if (event.outcome === "expired" || event.outcome === "lead_unavailable") tone = "warning";
  return {
    key: FAILURE_OUTCOMES.has(event.outcome)
      ? `leadDecided_${event.outcome}`
      : "leadDecided_unknown",
    tone,
    subject,
    detail: event.note ?? null,
  };
}

function describeRecoveryEvent(event: GoalEvent): Described | null {
  switch (event.type) {
    case "recovery.started":
      return { key: "recoveryStarted", tone: "default", subject: null };
    case "recovery.decided": {
      const { decision } = event;
      let key = "recoveryDecided_unknown";
      if (decision.fallback) key = "recoveryDecided_fallback";
      else if (RECOVERY_DECISIONS.has(decision.decision)) {
        key = `recoveryDecided_${decision.decision}`;
      }
      return {
        key,
        tone: decision.decision === "needs_person" ? "warning" : "default",
        subject: null,
        detail: decision.reason || null,
      };
    }
    case "recovery.resolved": {
      let tone: GoalFeedTone = "default";
      if (event.outcome === "applied") tone = "success";
      else if (event.outcome === "rejected" || event.outcome === "needs_person") tone = "warning";
      return {
        key: RECOVERY_OUTCOMES.has(event.outcome)
          ? `recoveryResolved_${event.outcome}`
          : "recoveryResolved_unknown",
        tone,
        subject: null,
        detail: event.reason ?? null,
      };
    }
    default:
      return null;
  }
}

/**
 * The goal's history as sentences, newest first. Consecutive events that say the same thing
 * (several tasks starting, the same task retried) fold into one line.
 */
export function buildGoalEventFeed(events: readonly GoalEvent[], goal: FeedGoal): GoalFeedEntry[] {
  const entries: GoalFeedEntry[] = [];
  for (const event of events) {
    const described = describeGoalEvent(event, goal);
    if (!described) {
      continue;
    }
    const last = entries[entries.length - 1];
    const detail = described.detail ?? null;
    const round = described.round ?? null;
    if (last && last.key === described.key && last.detail === detail && last.round === round) {
      if (described.subject && !last.subjects.includes(described.subject)) {
        last.subjects.push(described.subject);
      }
      last.count += 1;
      last.at = event.at;
      last.events.push(event);
      continue;
    }
    entries.push({
      id: event.id,
      key: described.key,
      tone: described.tone,
      subjects: described.subject ? [described.subject] : [],
      detail,
      count: 1,
      round,
      at: event.at,
      events: [event],
    });
  }
  return entries.toReversed();
}
