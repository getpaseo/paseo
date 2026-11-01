import type {
  AgentRun,
  ChangeSet,
  ChangeSetStatus,
  Goal,
  GoalConfig,
  GoalEvent,
  GoalStatus,
  GoalWaits,
  Guidance,
  GuidanceChanges,
  LeadIntervention,
  Notification,
  PlanRevision,
  Recovery,
  RecoveryDecision,
  ReworkReason,
  Task,
  TaskSpec,
  TurnUsage,
  UsageBreakdownEntry,
  UsageRole,
  UsageTotals,
} from "@getpaseo/protocol/goal/types";
import {
  CHANGE_SET_INTEGRATION_FAILED,
  CHANGE_SET_REWORK_FAILED,
  GOAL_TIME_LIMIT_PASSED,
  GOAL_TIME_MODES,
  MAX_ACCEPT_NOTE_CHARS,
} from "@getpaseo/protocol/goal/types";
import {
  LAST_ATTEMPT_TRIGGER,
  MAX_DECISION_REASON_CHARS,
  MAX_GUIDANCE_CHARS,
  MAX_INTERVENTION_ERROR_CHARS,
  MAX_NUDGE_CHARS,
  MAX_RECOVERIES,
  MAX_WORK_SUMMARY_CHARS,
  RECOVERY_DECISION_MS,
  type InterventionClass,
  capText,
  interventionClass,
} from "@getpaseo/protocol/goal/interventions";
import { acceptRefusal } from "@getpaseo/protocol/goal/acceptance";
import { liveRecovery } from "@getpaseo/protocol/goal/recovery-state";
import {
  absoluteDeadlineMs,
  budgetExceeded,
  goalDeadlineMs,
  resolveLimits,
} from "./goal-limits.js";
import {
  PlanRevisionError,
  checkRecoveryDecision,
  isInterventionLive,
  pendingRevision as pendingRevisionOf,
  revisionNeedsApproval,
  revisionTargets,
  revisedPlan,
  validatePlanRevision,
} from "./plan-revision.js";
import { readyTasks, validateTaskGraph } from "./task-graph.js";

export class GoalTransitionError extends Error {
  constructor(
    public readonly eventType: GoalEvent["type"],
    message: string,
  ) {
    super(`${eventType}: ${message}`);
    this.name = "GoalTransitionError";
  }
}

const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Delivery attempts per notification, the first included. */
export const MAX_NOTIFICATION_ATTEMPTS = 5;

/**
 * Wait before the next delivery attempt, indexed by attempts made so far minus one.
 * One wait sits between each pair of attempts, so it is one shorter than the cap.
 */
export const NOTIFICATION_BACKOFF_MS = [5_000, 30_000, 120_000, 300_000];

/** Times a person may send a goal's plan back to the Lead. */
export const MAX_PLAN_REJECTIONS = 5;

/** Plan revisions a goal may record after approval, whatever their outcome. */
export const MAX_PLAN_REVISIONS = 20;

/** Times the Lead may be woken about failed tasks over a goal's life, whatever the outcome. */
export const MAX_INTERVENTIONS_PER_GOAL = 4;

/** Failure wake-ups about one task. A wake-up about its last attempt is not counted. */
export const MAX_INTERVENTIONS_PER_TASK = 2;

/** Check-ins on one run while it is still going, and over a goal's life. */
export const MAX_CHECK_INS_PER_RUN = 3;
export const MAX_CHECK_INS_PER_GOAL = 12;

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return TERMINAL_GOAL_STATUSES.has(status);
}

function isCheckIn(intervention: Pick<LeadIntervention, "trigger">): boolean {
  return interventionClass(intervention) === "check_in";
}

/** Outcomes intervention.resolved may record per class; the reducer sets the others itself. */
const RESOLVED_OUTCOMES: Record<InterventionClass, ReadonlySet<string>> = {
  failure: new Set(["continue", "give_up", "expired", "lead_unavailable"]),
  check_in: new Set(["ok", "nudged", "stopped", "expired", "lead_unavailable"]),
  // recovery.decided resolves a recovery intervention with outcome "decided", fallbacks too.
  recovery: new Set(),
};

const CLASS_NAMES: Record<InterventionClass, string> = {
  failure: "failure wake-up",
  check_in: "check-in",
  recovery: "recovery decision",
};

/**
 * Interventions of the goal's current epoch: caps count again after each reopen, so a goal a
 * person or a recovery reopened can wake its Lead again. Interventions recorded before epochs
 * read as 0.
 */
function currentEpoch(goal: Goal): LeadIntervention[] {
  const epoch = goal.reopens ?? 0;
  return (goal.interventions ?? []).filter((i) => (i.epoch ?? 0) === epoch);
}

/**
 * Why the goal cannot take another failure wake-up about `taskId` with `trigger`, or null.
 * Every wake-up counts, whatever its outcome, so a failing task cannot wake the Lead forever.
 */
export function failureWakeUpCapError(goal: Goal, taskId: string, trigger: string): string | null {
  const failures = currentEpoch(goal).filter((i) => interventionClass(i) === "failure");
  if (failures.length >= MAX_INTERVENTIONS_PER_GOAL) {
    return `the Lead was already woken ${failures.length} times about failed tasks; the limit is ${MAX_INTERVENTIONS_PER_GOAL}`;
  }
  if (trigger === LAST_ATTEMPT_TRIGGER) return null;
  const forTask = failures.filter((i) => i.taskId === taskId && i.trigger !== LAST_ATTEMPT_TRIGGER);
  if (forTask.length >= MAX_INTERVENTIONS_PER_TASK) {
    return `the Lead was already woken ${forTask.length} times about task ${taskId}; the limit is ${MAX_INTERVENTIONS_PER_TASK}`;
  }
  return null;
}

/** Why the goal cannot take another check-in on `runId`, or null. */
export function checkInCapError(goal: Goal, runId: string): string | null {
  const checkIns = currentEpoch(goal).filter(isCheckIn);
  if (checkIns.length >= MAX_CHECK_INS_PER_GOAL) {
    return `the Lead already checked in ${checkIns.length} times; the limit is ${MAX_CHECK_INS_PER_GOAL}`;
  }
  const forRun = checkIns.filter((i) => i.runId === runId).length;
  if (forRun >= MAX_CHECK_INS_PER_RUN) {
    return `the Lead already checked in ${forRun} times on run ${runId}; the limit is ${MAX_CHECK_INS_PER_RUN}`;
  }
  return null;
}

/** Runs of a task that failed since a person last retried it; these count against maxAttempts. */
export function countedFailures(goal: Goal, taskId: string): number {
  const failed = goal.runs.filter((r) => r.taskId === taskId && r.status === "failed").length;
  const forgiven = goal.tasks.find((t) => t.id === taskId)?.forgivenFailures ?? 0;
  return failed - forgiven;
}

function toSpec(task: Task): TaskSpec {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    kind: task.kind,
    dependsOn: task.dependsOn,
    ...(task.provider ? { provider: task.provider } : {}),
  };
}

/**
 * Pure, deterministic fold of one event into goal state. Throws
 * GoalTransitionError when the event is not legal in the current state, so an
 * illegal event never reaches the log.
 */
export function applyGoalEvent(goal: Goal | null, event: GoalEvent): Goal {
  if (event.type === "goal.created") {
    if (goal) {
      throw new GoalTransitionError(event.type, "goal already exists");
    }
    if (event.seq !== 1) {
      throw new GoalTransitionError(event.type, `expected seq 1, got ${event.seq}`);
    }
    return {
      id: event.goalId,
      title: event.title,
      objective: event.objective,
      status: "planning",
      config: event.config ?? null,
      leadAgentId: null,
      leadWorkspaceId: null,
      runs: [],
      changeSets: [],
      integration: null,
      criteria: event.criteria.map((c) => ({
        id: c.id,
        text: c.text,
        verifiedAt: null,
        evidence: null,
      })),
      tasks: [],
      notifications: [],
      ...(event.priority ? { priority: event.priority } : {}),
      lastSeq: event.seq,
      failureReason: null,
      createdAt: event.at,
      updatedAt: event.at,
    };
  }

  if (!goal) {
    throw new GoalTransitionError(event.type, "goal does not exist");
  }
  if (event.seq !== goal.lastSeq + 1) {
    throw new GoalTransitionError(event.type, `expected seq ${goal.lastSeq + 1}, got ${event.seq}`);
  }
  if (event.type === "goal.acknowledged") {
    return { ...acknowledge(goal, event), lastSeq: event.seq, updatedAt: event.at };
  }
  const managed = applyManagementEvent(goal, event);
  if (managed) return { ...managed, lastSeq: event.seq, updatedAt: event.at };
  if (isTerminalGoalStatus(goal.status) && !allowedOnEndedGoal(goal, event)) {
    throw new GoalTransitionError(event.type, `goal is ${goal.status}`);
  }

  const next = withVerificationTimes(
    withWaitsClosed(goal, applyToLiveGoal(goal, event), event),
    event,
  );
  return { ...next, lastSeq: event.seq, updatedAt: event.at };
}

/**
 * Events an ended goal still takes, besides acknowledgement and management handled before.
 * A goal's outcome is sent as it ends, so its notifications outlive it.
 */
function allowedOnEndedGoal(goal: Goal, event: GoalEvent): boolean {
  if (event.type.startsWith("notification.")) return true;
  return goal.status === "failed" && allowedOnFailedGoal(goal, event);
}

/**
 * A failed goal can be reopened by a retry or a recovery. While the recovery's Lead decides,
 * it also takes the Lead and its decision prompt, and once a recovery exists, the Lead's usage,
 * which may land after the recovery ended.
 */
function allowedOnFailedGoal(goal: Goal, event: GoalEvent): boolean {
  switch (event.type) {
    case "goal.retried":
    case "goal.reopened":
    case "changeset.integration_retried":
    case "recovery.started":
    case "recovery.decided":
    case "recovery.resolved":
    case "goal.accepted":
      return true;
    case "usage.recorded":
      return event.role === "lead" && goal.recovery !== undefined;
    // The recovery's Lead may wait for a person's answer while it decides.
    case "wait.started":
      return goal.recovery?.status === "deciding";
    case "wait.ended":
      return goal.waits?.open[event.agentId] !== undefined;
    case "lead.attached":
      return goal.recovery?.status === "deciding";
    case "intervention.requested":
      return goal.recovery?.status === "deciding" && interventionClass(event) === "recovery";
    default:
      return false;
  }
}

// One definition, shared with the clients; re-exported for the daemon's other modules.
export { liveRecovery };

/** A retry, reopen or archive would race the recovery; the person cancels it first. */
function refuseWhileRecovering(goal: Goal, event: GoalEvent): void {
  const live = liveRecovery(goal);
  if (!live) return;
  const state = live.status === "awaiting_approval" ? "waiting for approval" : live.status;
  throw new GoalTransitionError(
    event.type,
    `recovery ${live.id} is ${state}; cancel the recovery first: paseo goal recover ${goal.id} --cancel`,
  );
}

/** A person dismissed an ended goal. Only the mark changes; a failed goal can still be retried. */
function acknowledge(goal: Goal, event: GoalEvent): Goal {
  if (!isTerminalGoalStatus(goal.status)) {
    throw new GoalTransitionError(
      event.type,
      `goal is ${goal.status}; only an ended goal can be acknowledged`,
    );
  }
  if (goal.acknowledgedAt) {
    throw new GoalTransitionError(event.type, "goal is already acknowledged");
  }
  return { ...goal, acknowledgedAt: event.at };
}

/** Config fields fixed for a goal's life; goal.config_updated must leave them as they are. */
const FIXED_CONFIG_FIELDS = [
  "cwd",
  "baseCommit",
  "leadProvider",
  "defaultProvider",
  "reviewProvider",
  "verifyProvider",
  "leadThinking",
  "workerThinking",
  "reviewThinking",
  "verifyThinking",
  "branchPrefix",
  "originAgentId",
  "allowedProviders",
] as const satisfies readonly (keyof GoalConfig)[];

/** A person changed the goal's settings. Accepted after the goal ended, so a failed goal can be retried with them. */
function updateConfig(
  goal: Goal,
  event: Extract<GoalEvent, { type: "goal.config_updated" }>,
): Goal {
  if (!goal.config) {
    throw new GoalTransitionError(event.type, "a manual goal has no settings to change");
  }
  if (goal.archivedAt) {
    throw new GoalTransitionError(event.type, "the goal is archived; unarchive it first");
  }
  const previous = goal.config;
  for (const field of FIXED_CONFIG_FIELDS) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(event.config[field])) {
      throw new GoalTransitionError(event.type, `${field} cannot be changed after creation`);
    }
  }
  return { ...goal, config: event.config };
}

/**
 * A person renames, reprioritises, archives or unarchives a goal, or changes its settings.
 * These are accepted after it ended. Returns null for any other event.
 */
function applyManagementEvent(goal: Goal, event: GoalEvent): Goal | null {
  switch (event.type) {
    case "goal.renamed":
      return { ...goal, title: event.title };
    case "goal.priority_set":
      return { ...goal, priority: event.priority };
    case "goal.archived":
      if (!isTerminalGoalStatus(goal.status)) {
        throw new GoalTransitionError(
          event.type,
          `goal is ${goal.status}; only an ended goal can be archived`,
        );
      }
      if (goal.archivedAt) throw new GoalTransitionError(event.type, "goal is already archived");
      refuseWhileRecovering(goal, event);
      return { ...goal, archivedAt: event.at };
    case "goal.unarchived":
      if (!goal.archivedAt) throw new GoalTransitionError(event.type, "goal is not archived");
      return { ...goal, archivedAt: null };
    case "goal.config_updated":
      return updateConfig(goal, event);
    default:
      return null;
  }
}

/**
 * Verification has no start event: it starts once every task succeeded and every
 * change set settled, and ends with the last criterion verified. Derived from the
 * event times alone, so replay gives the same answer.
 */
function withVerificationTimes(goal: Goal, event: GoalEvent): Goal {
  if (goal.status !== "executing" && goal.status !== "completed") return goal;
  // An accept completes without verifying; stamping a stage time now would invent one.
  if (event.type === "goal.accepted") return goal;
  let next = goal;
  if (!next.verifyStartedAt && readyToVerify(next)) {
    next = { ...next, verifyStartedAt: event.at };
  }
  if (
    !next.verifiedAt &&
    event.type === "criterion.verified" &&
    next.criteria.every((c) => c.verifiedAt)
  ) {
    next = { ...next, verifiedAt: event.at };
  }
  return next;
}

function readyToVerify(goal: Goal): boolean {
  return (
    goal.tasks.length > 0 &&
    // A pending revision may still add work.
    !goal.planRevisions?.some((r) => r.status === "pending") &&
    goal.tasks.every((t) => t.status === "succeeded") &&
    (!goal.config || goal.tasks.every((t) => t.kind !== "implement" || t.captured)) &&
    goal.changeSets.every((c) => c.status === "integrated" || c.status === "superseded")
  );
}

export function replayGoal(events: readonly GoalEvent[]): Goal | null {
  return events.reduce<Goal | null>((goal, event) => applyGoalEvent(goal, event), null);
}

function requireStatus(goal: Goal, event: GoalEvent, ...allowed: GoalStatus[]): void {
  if (!allowed.includes(goal.status)) {
    throw new GoalTransitionError(
      event.type,
      `requires goal status ${allowed.join(" or ")}, goal is ${goal.status}`,
    );
  }
}

function updateTask(
  goal: Goal,
  event: GoalEvent,
  taskId: string,
  from: Task["status"][],
  update: (task: Task) => Task,
): Goal {
  requireStatus(goal, event, "executing");
  const task = goal.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new GoalTransitionError(event.type, `unknown task ${taskId}`);
  }
  if (!from.includes(task.status)) {
    throw new GoalTransitionError(
      event.type,
      `task ${taskId} is ${task.status}, expected ${from.join(" or ")}`,
    );
  }
  return { ...goal, tasks: goal.tasks.map((t) => (t.id === taskId ? update(t) : t)) };
}

type EventHandler = (goal: Goal, event: GoalEvent) => Goal;

// Events are grouped by the first segment of their type.
const HANDLERS: Record<string, EventHandler> = {
  plan: (goal, event) => applyPlanEvent(goal, event),
  task: (goal, event) => applyTaskEvent(goal, event),
  lead: (goal, event) => applyRunEvent(goal, event),
  run: (goal, event) => applyRunEvent(goal, event),
  criterion: (goal, event) => applyGoalLevelEvent(goal, event),
  goal: (goal, event) => applyGoalLevelEvent(goal, event),
  capture: (goal, event) => applyChangeSetEvent(goal, event),
  changeset: (goal, event) => applyChangeSetEvent(goal, event),
  integration: (goal, event) => applyChangeSetEvent(goal, event),
  notification: (goal, event) => applyNotificationEvent(goal, event),
  usage: (goal, event) => applyUsageEvent(goal, event),
  intervention: (goal, event) => applyInterventionEvent(goal, event),
  recovery: (goal, event) => applyRecoveryEvent(goal, event),
  wait: (goal, event) => applyWaitEvent(goal, event),
};

function applyToLiveGoal(goal: Goal, event: GoalEvent): Goal {
  const handler = HANDLERS[event.type.split(".")[0] ?? ""];
  if (!handler) {
    throw new GoalTransitionError(event.type, "unknown event group");
  }
  return handler(goal, event);
}

const NO_WAITS: GoalWaits = { open: {}, excludedMs: 0, since: null };

/**
 * An agent starts or stops waiting for a person's answer. The goal's time limit leaves the
 * waiting out: `since` marks when the current stretch with any agent waiting began, and the
 * stretch is added to `excludedMs` when the last open wait closes, so overlapping waits count
 * once.
 */
function applyWaitEvent(goal: Goal, event: GoalEvent): Goal {
  const waits = goal.waits ?? NO_WAITS;
  switch (event.type) {
    case "wait.started": {
      if (waits.open[event.agentId]) {
        throw new GoalTransitionError(event.type, `agent ${event.agentId} is already waiting`);
      }
      if (event.runId) {
        const run = goal.runs.find((r) => r.id === event.runId);
        if (run?.status !== "running") {
          throw new GoalTransitionError(event.type, `run ${event.runId} is not running`);
        }
      }
      const opened = { since: event.at, ...(event.runId ? { runId: event.runId } : {}) };
      return {
        ...goal,
        waits: {
          ...waits,
          open: { ...waits.open, [event.agentId]: opened },
          since: waits.since ?? event.at,
        },
      };
    }
    case "wait.ended":
      if (!waits.open[event.agentId]) {
        throw new GoalTransitionError(event.type, `agent ${event.agentId} is not waiting`);
      }
      return {
        ...goal,
        waits: closeWaits(waits, event.at, (agentId) => agentId === event.agentId),
      };
    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

/** The waits left once `isClosed` ones close at `at`; the last one to close ends the stretch. */
function closeWaits(
  waits: GoalWaits,
  at: string,
  isClosed: (agentId: string, wait: GoalWaits["open"][string]) => boolean,
): GoalWaits {
  const entries = Object.entries(waits.open);
  const open = Object.fromEntries(entries.filter(([agentId, wait]) => !isClosed(agentId, wait)));
  if (Object.keys(open).length === entries.length) return waits;
  if (Object.keys(open).length > 0 || waits.since === null) return { ...waits, open };
  const stretch = Math.max(0, Date.parse(at) - Date.parse(waits.since));
  return {
    open,
    excludedMs: waits.excludedMs + (Number.isNaN(stretch) ? 0 : stretch),
    since: null,
  };
}

/**
 * Waits other events end: run.finished closes the wait of its run (found through the run id
 * wait.started recorded, since run.finished names no agent), and a goal that ends closes every
 * wait. A new time base clears the waiting counted before it, which the base already accounts
 * for; a wait still open counts from there.
 */
function withWaitsClosed(previous: Goal, next: Goal, event: GoalEvent): Goal {
  const waits = next.waits;
  if (!waits) return next;
  let after = waits;
  if (event.type === "run.finished") {
    after = closeWaits(after, event.at, (_agentId, wait) => wait.runId === event.runId);
  }
  if (isTerminalGoalStatus(next.status) && next.status !== previous.status) {
    after = closeWaits(after, event.at, () => true);
  }
  if (next.timeBaseAt !== previous.timeBaseAt) {
    const open = Object.keys(after.open).length > 0;
    after = { open: after.open, excludedMs: 0, since: open ? event.at : null };
  }
  return after === waits ? next : { ...next, waits: after };
}

function applyPlanEvent(goal: Goal, event: GoalEvent): Goal {
  switch (event.type) {
    case "plan.proposed": {
      requireStatus(goal, event, "planning");
      try {
        validateTaskGraph(event.tasks);
      } catch (error) {
        throw new GoalTransitionError(
          event.type,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (event.tasks.length === 0) {
        throw new GoalTransitionError(event.type, "plan has no tasks");
      }
      const { maxTasks } = resolveLimits(goal.config);
      if (event.tasks.length > maxTasks) {
        throw new GoalTransitionError(
          event.type,
          `plan has ${event.tasks.length} tasks; the limit is ${maxTasks}`,
        );
      }
      return {
        ...goal,
        status: "awaiting_plan_approval",
        tasks: event.tasks.map((spec) => ({
          ...spec,
          status: "pending",
          attempts: 0,
          error: null,
          summary: null,
        })),
      };
    }

    case "plan.approved":
      requireStatus(goal, event, "awaiting_plan_approval");
      return { ...goal, status: "executing" };

    case "plan.rejected": {
      requireStatus(goal, event, "awaiting_plan_approval");
      const rejections = goal.planRejections ?? [];
      if (rejections.length >= MAX_PLAN_REJECTIONS) {
        throw new GoalTransitionError(
          event.type,
          `the plan was already rejected ${rejections.length} times; the limit is ${MAX_PLAN_REJECTIONS}`,
        );
      }
      return {
        ...goal,
        status: "planning",
        tasks: [],
        planRejections: [
          ...rejections,
          { reason: event.reason, tasks: goal.tasks.map(toSpec), at: event.at },
        ],
      };
    }

    case "plan.revision_proposed":
      return proposeRevision(goal, event);

    case "plan.revision_approved":
      return approveRevision(goal, event);

    case "plan.revision_rejected": {
      const revision = pendingRevision(goal, event, event.revisionId);
      return decideRevision(goal, revision, "rejected", event.at, event.reason);
    }

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

/** Reports a plan revision check's refusal as a transition error. */
function revisionCheck<T>(event: GoalEvent, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof PlanRevisionError) {
      throw new GoalTransitionError(event.type, error.message);
    }
    throw error;
  }
}

function pendingRevision(goal: Goal, event: GoalEvent, revisionId: string): PlanRevision {
  requireStatus(goal, event, "executing");
  const revision = (goal.planRevisions ?? []).find((r) => r.id === revisionId);
  if (!revision) throw new GoalTransitionError(event.type, `unknown revision ${revisionId}`);
  if (revision.status !== "pending") {
    throw new GoalTransitionError(event.type, `revision ${revisionId} is ${revision.status}`);
  }
  return revision;
}

function patched<T extends PlanRevision | LeadIntervention>(item: T, patch: Partial<T>): T {
  return { ...item, ...patch };
}

function patchById<T extends PlanRevision | LeadIntervention>(
  items: T[],
  ids: ReadonlySet<string>,
  patch: Partial<T>,
): T[] {
  return items.map((item) => (ids.has(item.id) ? patched(item, patch) : item));
}

/** Refuses a proposal the goal cannot take, and returns the revision it replaces, if any. */
function checkProposal(
  goal: Goal,
  event: Extract<GoalEvent, { type: "plan.revision_proposed" }>,
): PlanRevision | undefined {
  requireStatus(goal, event, "executing");
  if (!goal.config) {
    throw new GoalTransitionError(event.type, "a manual goal's plan cannot be revised");
  }
  const revisions = goal.planRevisions ?? [];
  if (revisions.some((r) => r.id === event.revisionId)) {
    throw new GoalTransitionError(event.type, `revision ${event.revisionId} already exists`);
  }
  if (goal.verifyStartedAt) {
    throw new GoalTransitionError(event.type, "verification has started; the plan cannot change");
  }
  if (revisions.length >= MAX_PLAN_REVISIONS) {
    throw new GoalTransitionError(
      event.type,
      `the plan was already revised ${revisions.length} times; the limit is ${MAX_PLAN_REVISIONS}`,
    );
  }
  revisionCheck(event, () =>
    validatePlanRevision(goal, event.ops, event.source, event.interventionId),
  );
  const pending = revisions.find((r) => r.status === "pending");
  if (pending && event.source !== "person") {
    throw new GoalTransitionError(
      event.type,
      `revision ${pending.id} is still pending; wait for its decision`,
    );
  }
  if (event.interventionId) {
    const answered = goal.interventions?.find((i) => i.id === event.interventionId);
    if (answered?.status !== "open") {
      throw new GoalTransitionError(
        event.type,
        `intervention ${event.interventionId} is ${answered?.status ?? "unknown"}, expected open`,
      );
    }
  }
  return pending;
}

/**
 * Interventions a proposal ends: the one the replaced revision answered, and for a person's
 * revision every live one about a task it replaces or removes.
 */
function supersededInterventions(
  goal: Goal,
  event: Extract<GoalEvent, { type: "plan.revision_proposed" }>,
  pending: PlanRevision | undefined,
): Set<string> {
  const superseded = new Set<string>();
  if (pending?.interventionId) superseded.add(pending.interventionId);
  if (event.source !== "person") return superseded;
  const targets = revisionTargets(event.ops);
  for (const i of goal.interventions ?? []) {
    if (
      i.id !== event.interventionId &&
      isInterventionLive(i) &&
      i.taskId !== undefined &&
      targets.has(i.taskId)
    ) {
      superseded.add(i.id);
    }
  }
  return superseded;
}

/**
 * The Lead or a person proposes a change to the approved plan. One revision is pending at a
 * time; a person's replaces a pending one, and a person's change to a task the Lead was woken
 * about supersedes that intervention. The Lead answers an intervention only through a
 * revision naming it.
 */
function proposeRevision(
  goal: Goal,
  event: Extract<GoalEvent, { type: "plan.revision_proposed" }>,
): Goal {
  const pending = checkProposal(goal, event);
  const revision: PlanRevision = {
    id: event.revisionId,
    source: event.source,
    reason: event.reason,
    ops: event.ops,
    status: "pending",
    ...(event.interventionId ? { interventionId: event.interventionId } : {}),
    proposedAt: event.at,
  };
  const replaced = new Set(pending ? [pending.id] : []);
  const planRevisions = [
    ...patchById(goal.planRevisions ?? [], replaced, {
      status: "superseded",
      decidedAt: event.at,
      decisionReason: `superseded by revision ${event.revisionId}`,
    }),
    revision,
  ];
  if (!goal.interventions) return { ...goal, planRevisions };
  const superseded = patchById(goal.interventions, supersededInterventions(goal, event, pending), {
    status: "resolved",
    outcome: "superseded",
    resolvedAt: event.at,
  });
  const answered = new Set(event.interventionId ? [event.interventionId] : []);
  const interventions = patchById(superseded, answered, {
    status: "awaiting_approval",
    revisionId: event.revisionId,
  });
  return { ...goal, planRevisions, interventions };
}

/** Applies a pending revision's ops, checked again against the goal as it is now. */
function approveRevision(
  goal: Goal,
  event: Extract<GoalEvent, { type: "plan.revision_approved" }>,
): Goal {
  const revision = pendingRevision(goal, event, event.revisionId);
  // Verification does not start while a revision is pending, so this holds only for
  // criteria verified by other means; new work must not complete on their evidence.
  if (goal.verifyStartedAt || goal.criteria.some((c) => c.verifiedAt)) {
    throw new GoalTransitionError(event.type, "verification has started; the plan cannot change");
  }
  // Who proposed it is not checked again: an intervention opened since does not void it.
  const tasks = revisionCheck(event, () =>
    revisedPlan(goal, revision.ops, revision.interventionId),
  );
  return decideRevision({ ...goal, tasks }, revision, "applied", event.at);
}

/** Records the decision on a revision and resolves the intervention it answered. */
function decideRevision(
  goal: Goal,
  revision: PlanRevision,
  status: "applied" | "rejected",
  at: string,
  reason?: string,
): Goal {
  const planRevisions = patchById(goal.planRevisions ?? [], new Set([revision.id]), {
    status,
    decidedAt: at,
    ...(reason === undefined ? {} : { decisionReason: reason }),
  });
  if (!goal.interventions || !revision.interventionId) return { ...goal, planRevisions };
  const interventions = patchById(goal.interventions, new Set([revision.interventionId]), {
    status: "resolved",
    outcome: status === "applied" ? "revised" : "revision_rejected",
    resolvedAt: at,
  });
  return { ...goal, planRevisions, interventions };
}

/**
 * The goal ended: a pending revision can no longer apply and the Lead's decisions are no
 * longer needed. Leaves goals without revisions or interventions as they are, so older
 * logs replay unchanged.
 */
function abandonPlanChanges(goal: Goal, at: string): Partial<Goal> {
  const pending = (goal.planRevisions ?? []).filter((r) => r.status === "pending");
  const live = (goal.interventions ?? []).filter(isInterventionLive);
  const planRevisions =
    goal.planRevisions &&
    patchById(goal.planRevisions, new Set(pending.map((r) => r.id)), {
      status: "abandoned",
      decidedAt: at,
    });
  // No outcome: the Lead's decision was never taken.
  const interventions =
    goal.interventions &&
    patchById(goal.interventions, new Set(live.map((i) => i.id)), {
      status: "abandoned",
      resolvedAt: at,
    });
  return {
    ...(planRevisions ? { planRevisions } : {}),
    ...(interventions ? { interventions } : {}),
  };
}

function applyInterventionEvent(goal: Goal, event: GoalEvent): Goal {
  switch (event.type) {
    case "intervention.requested":
      return requestIntervention(goal, event);
    case "intervention.resolved":
      return resolveIntervention(goal, event);
    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

type InterventionRequest = Extract<GoalEvent, { type: "intervention.requested" }>;

/**
 * The Manager wakes the Lead about a task: after a failed run, or with a check-in while a run
 * is still going. One intervention is live per goal, of either kind, and none while a plan
 * revision waits, since the Lead's answer may be a revision.
 */
function requestIntervention(goal: Goal, event: InterventionRequest): Goal {
  const interventions = goal.interventions ?? [];
  if (interventions.some((i) => i.id === event.interventionId)) {
    throw new GoalTransitionError(
      event.type,
      `intervention ${event.interventionId} already exists`,
    );
  }
  const live = interventions.find(isInterventionLive);
  if (live) {
    throw new GoalTransitionError(event.type, `intervention ${live.id} is still ${live.status}`);
  }
  const pending = pendingRevisionOf(goal);
  if (pending) throw new GoalTransitionError(event.type, `revision ${pending.id} is pending`);
  // Each class of intervention has its own rules, caps and goal status. A trigger this
  // version does not know is refused rather than treated as one it does.
  let subject: { task: Task; run: AgentRun } | null;
  switch (interventionClass(event)) {
    case "check_in":
      subject = taskRun(goal, event);
      checkCheckIn(goal, event, subject.task, subject.run);
      break;
    case "failure":
      subject = taskRun(goal, event);
      checkFailureWakeUp(goal, event, subject.task, subject.run);
      break;
    case "recovery":
      return requestRecoveryDecision(goal, event);
    case null:
      throw new GoalTransitionError(event.type, `unknown trigger ${event.trigger}`);
  }
  // Recorded text is capped here, so a runaway error or summary cannot bloat the goal.
  const intervention: LeadIntervention = {
    id: event.interventionId,
    taskId: subject.task.id,
    runId: subject.run.id,
    trigger: event.trigger,
    error: capText(event.error, MAX_INTERVENTION_ERROR_CHARS),
    ...(event.triggers ? { triggers: event.triggers } : {}),
    ...(event.checkIn === undefined ? {} : { checkIn: event.checkIn }),
    ...(event.workSummary === undefined
      ? {}
      : { workSummary: capText(event.workSummary, MAX_WORK_SUMMARY_CHARS) }),
    status: "open",
    requestedAt: event.at,
    ...epochOf(goal),
  };
  return { ...goal, interventions: [...interventions, intervention] };
}

/** The epoch an intervention records; left out while it is 0, which absent reads as. */
function epochOf(goal: Goal): Pick<LeadIntervention, "epoch"> {
  return goal.reopens ? { epoch: goal.reopens } : {};
}

/**
 * The Lead of a failed goal's recovery is asked how to recover it: once per recovery, while
 * it decides, about the whole goal. It needs no leadInterventions setting: a person asked.
 */
function requestRecoveryDecision(goal: Goal, event: InterventionRequest): Goal {
  const recovery = goal.recovery;
  if (goal.status !== "failed" || recovery?.status !== "deciding") {
    throw new GoalTransitionError(event.type, "a recovery decision needs a recovery deciding");
  }
  if (event.taskId !== undefined || event.runId !== undefined) {
    throw new GoalTransitionError(event.type, "a recovery decision is about the goal, not a task");
  }
  if (event.checkIn !== undefined || event.triggers || event.workSummary !== undefined) {
    throw new GoalTransitionError(event.type, "a recovery decision carries no check-in fields");
  }
  if (recovery.interventionId) {
    throw new GoalTransitionError(
      event.type,
      `recovery ${recovery.id} already asked its Lead (intervention ${recovery.interventionId})`,
    );
  }
  if (!recovery.leadAgentId) {
    throw new GoalTransitionError(event.type, `recovery ${recovery.id} has no Lead yet`);
  }
  const intervention: LeadIntervention = {
    id: event.interventionId,
    trigger: event.trigger,
    error: capText(event.error, MAX_INTERVENTION_ERROR_CHARS),
    status: "open",
    requestedAt: event.at,
    ...epochOf(goal),
  };
  return {
    ...goal,
    interventions: [...(goal.interventions ?? []), intervention],
    recovery: { ...recovery, interventionId: intervention.id },
  };
}

/**
 * The task and run a failure wake-up or check-in is about; both are required for them. These
 * classes need an executing goal with the setting on and a Lead.
 */
function taskRun(goal: Goal, event: InterventionRequest): { task: Task; run: AgentRun } {
  requireStatus(goal, event, "executing");
  if (!goal.config?.leadInterventions) {
    throw new GoalTransitionError(event.type, "Lead interventions are off for this goal");
  }
  if (!goal.leadAgentId) throw new GoalTransitionError(event.type, "the goal has no Lead");
  if (!event.taskId || !event.runId) {
    throw new GoalTransitionError(event.type, `trigger ${event.trigger} needs a taskId and runId`);
  }
  const task = goal.tasks.find((t) => t.id === event.taskId);
  if (!task) throw new GoalTransitionError(event.type, `unknown task ${event.taskId}`);
  const run = goal.runs.find((r) => r.id === event.runId && r.taskId === task.id);
  if (!run) {
    throw new GoalTransitionError(event.type, `run ${event.runId} is not a run of task ${task.id}`);
  }
  return { task, run };
}

/**
 * A failure wake-up: about the latest run of a failed task, which failed, once per run, within
 * the caps. An earlier run is refused: the give_up guard on task.retried reads the latest run.
 */
function checkFailureWakeUp(
  goal: Goal,
  event: InterventionRequest,
  task: Task,
  run: AgentRun,
): void {
  if (task.rework) {
    throw new GoalTransitionError(event.type, `task ${task.id} is a rework task`);
  }
  if (task.status !== "failed") {
    throw new GoalTransitionError(event.type, `task ${task.id} is ${task.status}, expected failed`);
  }
  if (run.status !== "failed") {
    throw new GoalTransitionError(event.type, `run ${run.id} is ${run.status}, expected failed`);
  }
  const latest = goal.runs.findLast((r) => r.taskId === task.id);
  if (latest?.id !== run.id) {
    throw new GoalTransitionError(
      event.type,
      `run ${run.id} is not the latest run of task ${task.id} (${latest?.id})`,
    );
  }
  if (event.checkIn !== undefined || event.triggers) {
    throw new GoalTransitionError(event.type, "only a check-in carries checkIn or triggers");
  }
  const earlier = (goal.interventions ?? []).find(
    (i) => interventionClass(i) === "failure" && i.runId === run.id,
  );
  if (earlier) {
    throw new GoalTransitionError(
      event.type,
      `the Lead was already woken about run ${run.id} (intervention ${earlier.id})`,
    );
  }
  const capped = failureWakeUpCapError(goal, task.id, event.trigger);
  if (capped) throw new GoalTransitionError(event.type, capped);
}

/** A check-in: about the live run of a running task, numbered in order, within the caps. */
function checkCheckIn(goal: Goal, event: InterventionRequest, task: Task, run: AgentRun): void {
  if (task.status !== "running") {
    throw new GoalTransitionError(
      event.type,
      `task ${task.id} is ${task.status}, expected running`,
    );
  }
  // The run may end between the watcher's look and this event; the watcher skips then.
  if (run.status !== "running") {
    throw new GoalTransitionError(event.type, `run ${run.id} is ${run.status}, expected running`);
  }
  const capped = checkInCapError(goal, run.id);
  if (capped) throw new GoalTransitionError(event.type, capped);
  const next =
    (goal.interventions ?? []).filter((i) => isCheckIn(i) && i.runId === run.id).length + 1;
  if (event.checkIn !== next) {
    throw new GoalTransitionError(
      event.type,
      `check-in ${event.checkIn ?? "without a number"} on run ${run.id}, expected ${next}`,
    );
  }
}

/**
 * The Lead decided, or the Manager stopped waiting. Only an open intervention resolves here:
 * one awaiting approval of its revision is decided by plan.revision_approved or _rejected.
 */
function resolveIntervention(
  goal: Goal,
  event: Extract<GoalEvent, { type: "intervention.resolved" }>,
): Goal {
  const intervention = (goal.interventions ?? []).find((i) => i.id === event.interventionId);
  if (!intervention) {
    throw new GoalTransitionError(event.type, `unknown intervention ${event.interventionId}`);
  }
  if (intervention.status !== "open") {
    throw new GoalTransitionError(
      event.type,
      `intervention ${intervention.id} is ${intervention.status}, expected open`,
    );
  }
  const kind = interventionClass(intervention);
  if (!kind) {
    throw new GoalTransitionError(event.type, `unknown trigger ${intervention.trigger}`);
  }
  if (kind === "recovery") {
    throw new GoalTransitionError(
      event.type,
      "a recovery decision is recorded by recovery.decided, not intervention.resolved",
    );
  }
  // Failure wake-ups and check-ins are about the work of an executing goal.
  requireStatus(goal, event, "executing");
  const outcomes = RESOLVED_OUTCOMES[kind];
  if (!outcomes.has(event.outcome)) {
    throw new GoalTransitionError(
      event.type,
      `outcome ${event.outcome} does not resolve a ${CLASS_NAMES[kind]}; expected ${[...outcomes].join(", ")}`,
    );
  }
  if ((event.outcome === "nudged") !== (event.message !== undefined)) {
    throw new GoalTransitionError(event.type, "a message is recorded with outcome nudged only");
  }
  // Stopping a run that is merely quiet would throw away work on a guess.
  if (event.outcome === "stopped" && !intervention.triggers?.includes("near_timeout")) {
    throw new GoalTransitionError(event.type, "the Lead may stop a run only near its time limit");
  }
  const resolved: LeadIntervention = {
    ...intervention,
    status: "resolved",
    outcome: event.outcome,
    ...(event.note === undefined ? {} : { note: capText(event.note, MAX_DECISION_REASON_CHARS) }),
    ...(event.message === undefined ? {} : { message: capText(event.message, MAX_NUDGE_CHARS) }),
    resolvedAt: event.at,
  };
  return {
    ...goal,
    interventions: (goal.interventions ?? []).map((i) => (i.id === resolved.id ? resolved : i)),
  };
}

/** A run ended while the Lead was checking in on it; its answer no longer applies. */
function endCheckIns(goal: Goal, at: string, ended: (i: LeadIntervention) => boolean): Goal {
  if (!goal.interventions) return goal;
  const ids = new Set(
    goal.interventions
      .filter((i) => i.status === "open" && isCheckIn(i) && ended(i))
      .map((i) => i.id),
  );
  if (ids.size === 0) return goal;
  return {
    ...goal,
    interventions: patchById(goal.interventions, ids, {
      status: "resolved",
      outcome: "run_ended",
      resolvedAt: at,
    }),
  };
}

/** A task the Lead is deciding about waits for that decision. */
function refuseWhileDeciding(goal: Goal, event: GoalEvent, taskId: string): void {
  const live = goal.interventions?.find((i) => i.taskId === taskId && isInterventionLive(i));
  if (live) {
    throw new GoalTransitionError(
      event.type,
      `task ${taskId} waits for the Lead's decision (intervention ${live.id})`,
    );
  }
}

/**
 * A task is retried only once its run ended, and not after the Lead gave up on its last
 * failure. Goals that never woke the Lead replay as before: these rules read interventions.
 */
function checkRetry(goal: Goal, event: GoalEvent, taskId: string): void {
  if (!goal.interventions) return;
  refuseWhileDeciding(goal, event, taskId);
  const runs = goal.runs.filter((r) => r.taskId === taskId);
  if (runs.some((r) => r.status === "running")) {
    throw new GoalTransitionError(event.type, `task ${taskId} still has a live run`);
  }
  const last = runs.at(-1);
  const gaveUp =
    last &&
    goal.interventions.find(
      (i) => i.runId === last.id && i.outcome === "give_up" && interventionClass(i) === "failure",
    );
  if (gaveUp) {
    throw new GoalTransitionError(
      event.type,
      `the Lead gave up on task ${taskId} (intervention ${gaveUp.id})`,
    );
  }
}

/**
 * A person's retry wins over the Lead: live interventions about the retried tasks end as
 * superseded, and a revision answering one of them is superseded with it.
 */
function supersedeForRetry(
  goal: Goal,
  retried: ReadonlySet<string>,
  event: GoalEvent,
): Partial<Goal> {
  if (!goal.interventions) return {};
  const live = goal.interventions.filter(
    (i) => i.taskId !== undefined && retried.has(i.taskId) && isInterventionLive(i),
  );
  if (live.length === 0) return {};
  const answering = new Set(
    live.map((i) => i.revisionId).filter((id): id is string => id !== undefined),
  );
  return {
    interventions: patchById(goal.interventions, new Set(live.map((i) => i.id)), {
      status: "resolved",
      outcome: "superseded",
      resolvedAt: event.at,
    }),
    ...(goal.planRevisions && answering.size > 0
      ? {
          planRevisions: patchById(
            goal.planRevisions,
            new Set(
              goal.planRevisions
                .filter((r) => r.status === "pending" && answering.has(r.id))
                .map((r) => r.id),
            ),
            {
              status: "superseded",
              decidedAt: event.at,
              decisionReason: "superseded by a person's retry",
            },
          ),
        }
      : {}),
  };
}

function applyTaskEvent(goal: Goal, event: GoalEvent): Goal {
  switch (event.type) {
    case "task.started": {
      requireStatus(goal, event, "executing");
      if (!readyTasks(goal.tasks).some((t) => t.id === event.taskId)) {
        const known = goal.tasks.some((t) => t.id === event.taskId);
        throw new GoalTransitionError(
          event.type,
          known ? `task ${event.taskId} is not ready` : `unknown task ${event.taskId}`,
        );
      }
      const revising = goal.planRevisions?.find(
        (r) => r.status === "pending" && revisionTargets(r.ops).has(event.taskId),
      );
      if (revising) {
        throw new GoalTransitionError(
          event.type,
          `task ${event.taskId} is changed by pending revision ${revising.id}`,
        );
      }
      refuseWhileDeciding(goal, event, event.taskId);
      return updateTask(goal, event, event.taskId, ["pending"], (t) => ({
        ...t,
        status: "running",
        attempts: t.attempts + 1,
      }));
    }

    case "task.succeeded": {
      const succeeded = updateTask(goal, event, event.taskId, ["running"], (t) => ({
        ...t,
        status: "succeeded",
        error: null,
        summary: event.summary ?? null,
      }));
      return endCheckIns(succeeded, event.at, (i) => i.taskId === event.taskId);
    }

    case "task.failed": {
      const failed = updateTask(goal, event, event.taskId, ["running"], (t) => ({
        ...t,
        status: "failed",
        error: event.error,
      }));
      return endCheckIns(failed, event.at, (i) => i.taskId === event.taskId);
    }

    case "task.retried":
      checkRetry(goal, event, event.taskId);
      return updateTask(goal, event, event.taskId, ["running", "failed"], (t) => ({
        ...t,
        status: "pending",
        error: null,
      }));

    case "task.cancelled":
      return updateTask(goal, event, event.taskId, ["pending", "running"], (t) => ({
        ...t,
        status: "cancelled",
      }));

    case "task.added": {
      requireStatus(goal, event, "executing");
      if (goal.tasks.some((t) => t.id === event.task.id)) {
        throw new GoalTransitionError(event.type, `task ${event.task.id} already exists`);
      }
      if (!goal.changeSets.some((c) => c.id === event.rework.changeSetId)) {
        throw new GoalTransitionError(event.type, `unknown change set ${event.rework.changeSetId}`);
      }
      const added: Task = {
        ...event.task,
        status: "pending",
        attempts: 0,
        error: null,
        summary: null,
        rework: event.rework,
      };
      return { ...goal, tasks: [...goal.tasks, added] };
    }

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

function interruptLiveRuns(runs: AgentRun[], at: string): AgentRun[] {
  return runs.map((r) =>
    r.status === "running" ? { ...r, status: "interrupted", endedAt: at } : r,
  );
}

function updateRun(
  goal: Goal,
  event: GoalEvent,
  runId: string,
  update: (run: AgentRun) => AgentRun,
): Goal {
  requireStatus(goal, event, "executing");
  const run = goal.runs.find((r) => r.id === runId);
  if (!run) {
    throw new GoalTransitionError(event.type, `unknown run ${runId}`);
  }
  if (run.status !== "running") {
    throw new GoalTransitionError(event.type, `run ${runId} is ${run.status}`);
  }
  return { ...goal, runs: goal.runs.map((r) => (r.id === runId ? update(r) : r)) };
}

function applyRunEvent(goal: Goal, event: GoalEvent): Goal {
  switch (event.type) {
    case "lead.attached":
      // The terminal gate lets it reach a failed goal only while a recovery decides.
      if (goal.status === "failed") return attachRecoveryLead(goal, event);
      requireStatus(goal, event, "planning", "awaiting_plan_approval");
      return {
        ...goal,
        leadAgentId: event.agentId,
        leadWorkspaceId: event.workspaceId ?? goal.leadWorkspaceId,
      };

    // Only in logs from before notifications were recorded. Its outcome was never
    // written down, so it creates no entry and is never sent again.
    case "lead.notified":
      requireStatus(goal, event, "executing");
      return goal;

    case "run.started": {
      requireStatus(goal, event, "executing");
      const task = goal.tasks.find((t) => t.id === event.taskId);
      if (!task || task.status !== "running") {
        throw new GoalTransitionError(event.type, `task ${event.taskId} is not running`);
      }
      if (goal.runs.some((r) => r.id === event.runId)) {
        throw new GoalTransitionError(event.type, `run ${event.runId} already exists`);
      }
      if (goal.runs.some((r) => r.taskId === event.taskId && r.status === "running")) {
        throw new GoalTransitionError(event.type, `task ${event.taskId} already has a live run`);
      }
      const run: AgentRun = {
        id: event.runId,
        taskId: event.taskId,
        provider: event.provider,
        agentId: null,
        workspaceId: null,
        cwd: null,
        status: "running",
        startedAt: event.at,
        endedAt: null,
        error: null,
      };
      return { ...goal, runs: [...goal.runs, run] };
    }

    case "run.attached":
      return updateRun(goal, event, event.runId, (r) => ({
        ...r,
        agentId: event.agentId,
        workspaceId: event.workspaceId,
        cwd: event.cwd ?? null,
        ...(event.thinking ? { thinking: event.thinking } : {}),
      }));

    case "run.finished": {
      const finished = updateRun(goal, event, event.runId, (r) => ({
        ...r,
        status: event.outcome,
        endedAt: event.at,
        error: event.error ?? null,
      }));
      return endCheckIns(finished, event.at, (i) => i.runId === event.runId);
    }

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

// What a change set may move to from each status. `integrating` is reachable
// only from `approved`, and `approved` only from a review verdict or a person,
// so unreviewed work can never be merged.
const CHANGE_SET_TRANSITIONS: Record<ChangeSetStatus, readonly ChangeSetStatus[]> = {
  captured: ["in_review"],
  in_review: ["approved", "awaiting_human", "changes_requested", "rejected"],
  awaiting_human: ["approved", "changes_requested", "rejected"],
  approved: ["integrating"],
  // Back to approved when a restart interrupts a merge, so it can be retried.
  integrating: ["integrated", "conflicted", "test_failed", "approved", "rejected"],
  integrated: [],
  changes_requested: ["superseded", "rejected"],
  conflicted: ["superseded", "rejected"],
  test_failed: ["superseded", "rejected"],
  superseded: [],
  rejected: [],
};

function applyChangeSetEvent(goal: Goal, event: GoalEvent): Goal {
  if (event.type === "changeset.integration_retried") return applyIntegrationRetry(goal, event);
  requireStatus(goal, event, "executing");
  switch (event.type) {
    case "integration.prepared":
      if (goal.integration) {
        throw new GoalTransitionError(event.type, "integration already prepared");
      }
      return {
        ...goal,
        integration: {
          branch: event.branch,
          workspaceId: event.workspaceId,
          cwd: event.cwd,
          baseCommit: event.baseCommit,
          headCommit: event.baseCommit,
        },
      };

    case "changeset.captured": {
      const task = goal.tasks.find((t) => t.id === event.taskId);
      if (!task || task.status !== "succeeded" || task.kind !== "implement") {
        throw new GoalTransitionError(
          event.type,
          `task ${event.taskId} is not a succeeded implement task`,
        );
      }
      if (goal.changeSets.some((c) => c.id === event.changeSetId)) {
        throw new GoalTransitionError(event.type, `change set ${event.changeSetId} exists`);
      }
      const previous = event.supersedes
        ? goal.changeSets.find((c) => c.id === event.supersedes)
        : undefined;
      if (event.supersedes && !previous) {
        throw new GoalTransitionError(event.type, `unknown change set ${event.supersedes}`);
      }
      if (previous && !CHANGE_SET_TRANSITIONS[previous.status].includes("superseded")) {
        throw new GoalTransitionError(
          event.type,
          `change set ${previous.id} is ${previous.status} and cannot be superseded`,
        );
      }
      const captured: ChangeSet = {
        id: event.changeSetId,
        taskId: event.taskId,
        runId: event.runId,
        round: event.round,
        supersedes: event.supersedes,
        workspaceId: event.workspaceId,
        cwd: event.cwd,
        branch: event.branch,
        baseCommit: event.baseCommit,
        headCommit: event.headCommit,
        files: event.files,
        status: "captured",
        findings: null,
        testSummary: null,
        integratedCommit: null,
        error: null,
        createdAt: event.at,
        updatedAt: event.at,
      };
      // The new change set replaces the old one in the same step, so a crash cannot
      // leave both open.
      return {
        ...goal,
        tasks: markCaptured(goal.tasks, event.taskId),
        changeSets: [
          ...goal.changeSets.map((c) =>
            c.id === previous?.id
              ? { ...c, status: "superseded" as const, updatedAt: event.at }
              : c,
          ),
          captured,
        ],
      };
    }

    case "capture.skipped": {
      const task = goal.tasks.find((t) => t.id === event.taskId);
      if (!task || task.status !== "succeeded" || task.kind !== "implement") {
        throw new GoalTransitionError(
          event.type,
          `task ${event.taskId} is not a succeeded implement task`,
        );
      }
      return { ...goal, tasks: markCaptured(goal.tasks, event.taskId) };
    }

    case "changeset.transitioned":
      return transitionChangeSet(goal, event);

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

function markCaptured(tasks: Task[], taskId: string): Task[] {
  return tasks.map((t) => (t.id === taskId ? { ...t, captured: true } : t));
}

function transitionChangeSet(
  goal: Goal,
  event: Extract<GoalEvent, { type: "changeset.transitioned" }>,
): Goal {
  const current = goal.changeSets.find((c) => c.id === event.changeSetId);
  if (!current) {
    throw new GoalTransitionError(event.type, `unknown change set ${event.changeSetId}`);
  }
  if (!CHANGE_SET_TRANSITIONS[current.status].includes(event.to)) {
    throw new GoalTransitionError(
      event.type,
      `change set ${current.id} cannot go from ${current.status} to ${event.to}`,
    );
  }
  if (event.to === "integrated" && !event.integratedCommit) {
    throw new GoalTransitionError(event.type, "integrated requires integratedCommit");
  }
  const next: ChangeSet = {
    ...current,
    ...stageTimes(current, event.to, event.at),
    status: event.to,
    findings: event.findings ?? current.findings,
    testSummary: event.testSummary ?? current.testSummary,
    integratedCommit: event.integratedCommit ?? current.integratedCommit,
    // A change set that ends keeps the reason it needed fixing; live ones start clean.
    error:
      event.error ?? (event.to === "superseded" || event.to === "rejected" ? current.error : null),
    ...rejectionReason(goal, current, event),
    updatedAt: event.at,
  };
  return {
    ...goal,
    changeSets: goal.changeSets.map((c) => (c.id === current.id ? next : c)),
    integration:
      event.to === "integrated" && goal.integration
        ? { ...goal.integration, headCommit: event.integratedCommit as string }
        : goal.integration,
  };
}

/** The error the pipeline writes when a change set's rework task failed for good. */
const LEGACY_REWORK_FAILED = /^Rework \S+ failed: /;

/**
 * Why a change set is rejected, when the transition says or the error tells. Events from
 * before v0.13.10 carry no reason; for them a rejection out of `integrating` whose error says
 * the integration failed means the same, since only the merge step writes that.
 */
function rejectionReason(
  goal: Goal,
  current: ChangeSet,
  event: Extract<GoalEvent, { type: "changeset.transitioned" }>,
): Pick<ChangeSet, "rejectionReason"> {
  if (event.to !== "rejected") return {};
  if (event.reason) return { rejectionReason: event.reason };
  const legacyIntegrationFailure =
    current.status === "integrating" && event.error?.startsWith("Integration failed") === true;
  if (legacyIntegrationFailure) return { rejectionReason: CHANGE_SET_INTEGRATION_FAILED };
  // COMPAT(goalReworkRetry): logs before v0.13.14 carry no reason; permanent for those logs.
  // Only the pipeline's reworkFailed writes this error, for a change set waiting on its rework.
  const legacyReworkFailure =
    reworkReasonFor(current.status) !== null &&
    LEGACY_REWORK_FAILED.test(event.error ?? "") &&
    goal.tasks.some((t) => t.rework?.changeSetId === current.id);
  return legacyReworkFailure ? { rejectionReason: CHANGE_SET_REWORK_FAILED } : {};
}

/** True for a change set rejected because its merge step failed, which a retry can merge again. */
export function isIntegrationFailed(cs: ChangeSet): boolean {
  return cs.status === "rejected" && cs.rejectionReason === CHANGE_SET_INTEGRATION_FAILED;
}

/** True for a change set rejected because its rework failed, which a reopen can rework again. */
export function isReworkFailed(cs: ChangeSet): boolean {
  return cs.status === "rejected" && cs.rejectionReason === CHANGE_SET_REWORK_FAILED;
}

/** Why a change set in `status` needs rework, or null when it does not wait for one. */
export function reworkReasonFor(status: ChangeSetStatus): ReworkReason | null {
  switch (status) {
    case "changes_requested":
      return "review";
    case "conflicted":
      return "conflict";
    case "test_failed":
      return "tests";
    default:
      return null;
  }
}

/** The status a change set waited for its rework in; the inverse of reworkReasonFor. */
function statusForRework(reason: ReworkReason): ChangeSetStatus {
  switch (reason) {
    case "review":
      return "changes_requested";
    case "conflict":
      return "conflicted";
    case "tests":
      return "test_failed";
  }
}

/** Times a change set entered and left review and merge; the first entry into merging counts. */
function stageTimes(
  current: ChangeSet,
  to: ChangeSetStatus,
  at: string,
): Partial<Pick<ChangeSet, "reviewStartedAt" | "reviewedAt" | "mergeStartedAt" | "mergedAt">> {
  if (to === "in_review") return { reviewStartedAt: at };
  if (current.status === "in_review") return { reviewedAt: at };
  if (to === "integrating" && !current.mergeStartedAt) return { mergeStartedAt: at };
  if (to === "integrated") return { mergedAt: at };
  return {};
}

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  reportedTurns: 0,
  totalTurns: 0,
};

function addUsage(totals: UsageTotals | undefined, turn: TurnUsage | undefined): UsageTotals {
  const base = totals ?? EMPTY_USAGE;
  const costReportedTurns = base.costReportedTurns ?? 0;
  const tokenReportedTurns = base.tokenReportedTurns ?? 0;
  if (!turn) {
    return { ...base, totalTurns: base.totalTurns + 1, costReportedTurns, tokenReportedTurns };
  }
  const input = turn.inputTokens ?? 0;
  const output = turn.outputTokens ?? 0;
  const reportedTokens =
    turn.inputTokens !== undefined ||
    turn.cachedInputTokens !== undefined ||
    turn.outputTokens !== undefined;
  return {
    inputTokens: base.inputTokens + input,
    cachedInputTokens: base.cachedInputTokens + (turn.cachedInputTokens ?? 0),
    outputTokens: base.outputTokens + output,
    totalTokens: base.totalTokens + input + output,
    costUsd: base.costUsd + (turn.costUsd ?? 0),
    reportedTurns: base.reportedTurns + 1,
    totalTurns: base.totalTurns + 1,
    costReportedTurns: costReportedTurns + (turn.costUsd !== undefined ? 1 : 0),
    tokenReportedTurns: tokenReportedTurns + (reportedTokens ? 1 : 0),
  };
}

/** Agents the breakdown keeps; the least recently active ones are dropped past this. */
export const MAX_USAGE_BREAKDOWN_ENTRIES = 200;

/** "codex/<model>" names a provider and model; a bare id names the provider only. */
function splitProvider(value: string | undefined): { provider?: string; model?: string } {
  if (!value) return {};
  const slash = value.indexOf("/");
  return slash < 0
    ? { provider: value }
    : { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** The provider and thinking a role's agents start with, from the run or the goal's config. */
function roleDefaults(
  config: GoalConfig | null,
  role: UsageRole,
  run: AgentRun | undefined,
): { provider?: string; thinking?: string } {
  if (role === "worker") return { provider: run?.provider, thinking: run?.thinking };
  if (!config) return {};
  if (role === "lead") return { provider: config.leadProvider, thinking: config.leadThinking };
  const reviewProvider = config.reviewProvider ?? config.leadProvider;
  if (role === "reviewer") return { provider: reviewProvider, thinking: config.reviewThinking };
  return { provider: config.verifyProvider ?? reviewProvider, thinking: config.verifyThinking };
}

/** The entries of `fields` that have a value. */
function defined<T extends Record<string, string | undefined>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * Who the agent behind a usage event is. The provider comes from what the goal fixed at
 * creation, or the run's own provider for a worker, so logs written before events named
 * it describe their agents the same way.
 */
function describeUsageAgent(
  goal: Goal,
  event: Extract<GoalEvent, { type: "usage.recorded" }>,
): Omit<UsageBreakdownEntry, "usage" | "firstAt" | "lastAt"> {
  const run = event.runId ? goal.runs.find((r) => r.id === event.runId) : undefined;
  const changeSet = event.changeSetId
    ? goal.changeSets.find((c) => c.id === event.changeSetId)
    : undefined;
  const defaults = roleDefaults(goal.config, event.role, run);
  return {
    agentId: event.agentId,
    role: event.role,
    ...defined({
      taskId: run?.taskId ?? changeSet?.taskId,
      runId: event.runId,
      changeSetId: event.changeSetId,
    }),
    ...splitProvider(defaults.provider),
    ...defined({ thinking: event.thinking ?? defaults.thinking }),
  };
}

/** Adds the turn to its agent's entry and moves the entry to the end, the most recently active. */
function addToBreakdown(
  goal: Goal,
  event: Extract<GoalEvent, { type: "usage.recorded" }>,
): Pick<Goal, "usageBreakdown" | "usageBreakdownTruncated"> {
  const entries = goal.usageBreakdown ?? [];
  const existing = entries.find((e) => e.agentId === event.agentId && e.role === event.role);
  const updated: UsageBreakdownEntry = existing
    ? { ...existing, usage: addUsage(existing.usage, event.usage), lastAt: event.at }
    : {
        ...describeUsageAgent(goal, event),
        usage: addUsage(undefined, event.usage),
        firstAt: event.at,
        lastAt: event.at,
      };
  const next = [...entries.filter((e) => e !== existing), updated];
  const dropped = Math.max(0, next.length - MAX_USAGE_BREAKDOWN_ENTRIES);
  const truncated = (goal.usageBreakdownTruncated ?? 0) + dropped;
  return {
    usageBreakdown: dropped > 0 ? next.slice(dropped) : next,
    ...(truncated > 0 ? { usageBreakdownTruncated: truncated } : {}),
  };
}

/**
 * An agent turn ended; add what its provider reported to the goal, its role, its agent's
 * breakdown entry and, for a worker, its run.
 */
function applyUsageEvent(goal: Goal, event: GoalEvent): Goal {
  if (event.type !== "usage.recorded") {
    throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
  if (event.role === "worker" && !event.runId) {
    throw new GoalTransitionError(event.type, "a worker turn names its run");
  }
  if (event.runId && !goal.runs.some((r) => r.id === event.runId)) {
    throw new GoalTransitionError(event.type, `unknown run ${event.runId}`);
  }
  const byRole = goal.usageByRole ?? {};
  return {
    ...goal,
    usage: addUsage(goal.usage, event.usage),
    usageByRole: { ...byRole, [event.role]: addUsage(byRole[event.role], event.usage) },
    ...addToBreakdown(goal, event),
    runs: event.runId
      ? goal.runs.map((r) =>
          r.id === event.runId ? { ...r, usage: addUsage(r.usage, event.usage) } : r,
        )
      : goal.runs,
  };
}

function applyNotificationEvent(goal: Goal, event: GoalEvent): Goal {
  const notifications = goal.notifications ?? [];
  switch (event.type) {
    case "notification.queued": {
      if (notifications.some((n) => n.target === event.target && n.key === event.key)) {
        throw new GoalTransitionError(
          event.type,
          `notification ${event.target}:${event.key} already queued`,
        );
      }
      const queued: Notification = {
        key: event.key,
        target: event.target,
        text: event.text,
        status: "pending",
        attempts: 0,
        lastError: null,
        updatedAt: event.at,
      };
      return { ...goal, notifications: [...notifications, queued] };
    }

    case "notification.attempted": {
      const current = notifications.find((n) => n.target === event.target && n.key === event.key);
      if (!current) {
        throw new GoalTransitionError(
          event.type,
          `unknown notification ${event.target}:${event.key}`,
        );
      }
      if (current.status !== "pending") {
        throw new GoalTransitionError(
          event.type,
          `notification ${event.target}:${event.key} is ${current.status}`,
        );
      }
      if (event.attempt !== current.attempts + 1 || event.attempt > MAX_NOTIFICATION_ATTEMPTS) {
        throw new GoalTransitionError(
          event.type,
          `expected attempt ${current.attempts + 1} of at most ${MAX_NOTIFICATION_ATTEMPTS}, got ${event.attempt}`,
        );
      }
      const delivered = event.outcome === "delivered";
      // A failure is final only on the last attempt allowed.
      let status: Notification["status"] = "pending";
      if (delivered) status = "delivered";
      else if (event.attempt >= MAX_NOTIFICATION_ATTEMPTS) status = "failed";
      const next: Notification = {
        ...current,
        status,
        attempts: event.attempt,
        lastError: delivered ? current.lastError : (event.error ?? "unknown error"),
        updatedAt: event.at,
      };
      return { ...goal, notifications: notifications.map((n) => (n === current ? next : n)) };
    }

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

/** A criterion passed, in the goal's current verification round. */
function verifyCriterion(
  goal: Goal,
  event: Extract<GoalEvent, { type: "criterion.verified" }>,
): Goal {
  requireStatus(goal, event, "executing");
  const criterion = goal.criteria.find((c) => c.id === event.criterionId);
  if (!criterion) {
    throw new GoalTransitionError(event.type, `unknown criterion ${event.criterionId}`);
  }
  if (criterion.verifiedAt) {
    throw new GoalTransitionError(event.type, `criterion ${event.criterionId} already verified`);
  }
  const round = goal.verificationRound ?? 0;
  if (event.round !== undefined && event.round !== round) {
    throw new GoalTransitionError(
      event.type,
      `the result is for verification round ${event.round}; the goal is in round ${round}`,
    );
  }
  return {
    ...goal,
    criteria: goal.criteria.map((c) =>
      c.id === event.criterionId
        ? { ...c, verifiedAt: event.at, evidence: event.evidence ?? null }
        : c,
    ),
  };
}

function applyGoalLevelEvent(goal: Goal, event: GoalEvent): Goal {
  switch (event.type) {
    case "criterion.verified":
      return verifyCriterion(goal, event);

    case "goal.completed": {
      requireStatus(goal, event, "executing");
      const revising = goal.planRevisions?.find((r) => r.status === "pending");
      if (revising) {
        throw new GoalTransitionError(event.type, `revision ${revising.id} is pending`);
      }
      const open = goal.tasks.filter((t) => t.status !== "succeeded");
      if (open.length > 0) {
        throw new GoalTransitionError(
          event.type,
          `tasks not succeeded: ${open.map((t) => t.id).join(", ")}`,
        );
      }
      const unsettled = goal.changeSets.filter(
        (c) => c.status !== "integrated" && c.status !== "superseded",
      );
      if (unsettled.length > 0) {
        throw new GoalTransitionError(
          event.type,
          `change sets not integrated: ${unsettled.map((c) => c.id).join(", ")}`,
        );
      }
      // In a managed goal, an implement task whose work was never captured may have
      // changes nobody reviewed.
      const uncaptured = goal.config
        ? goal.tasks.filter((t) => t.kind === "implement" && !t.captured)
        : [];
      if (uncaptured.length > 0) {
        throw new GoalTransitionError(
          event.type,
          `work not captured for: ${uncaptured.map((t) => t.id).join(", ")}`,
        );
      }
      const unverified = goal.criteria.filter((c) => !c.verifiedAt);
      if (unverified.length > 0) {
        throw new GoalTransitionError(
          event.type,
          `criteria not verified: ${unverified.map((c) => c.id).join(", ")}`,
        );
      }
      return { ...goal, status: "completed", ...endAppliedRecovery(goal) };
    }

    case "goal.failed":
      // Pending tasks never ran and stay pending; anything live is closed out.
      return {
        ...goal,
        status: "failed",
        failureReason: event.reason,
        failedAt: event.at,
        tasks: goal.tasks.map((t) => (t.status === "running" ? { ...t, status: "cancelled" } : t)),
        runs: interruptLiveRuns(goal.runs, event.at),
        ...abandonPlanChanges(goal, event.at),
        ...endAppliedRecovery(goal),
      };

    case "goal.cancelled":
      return {
        ...goal,
        status: "cancelled",
        tasks: goal.tasks.map((t) =>
          t.status === "pending" || t.status === "running" ? { ...t, status: "cancelled" } : t,
        ),
        runs: interruptLiveRuns(goal.runs, event.at),
        ...abandonPlanChanges(goal, event.at),
        ...endAppliedRecovery(goal),
      };

    case "goal.paused":
      if (goal.pausedAt) throw new GoalTransitionError(event.type, "goal is already paused");
      return { ...goal, pausedAt: event.at };

    case "goal.resumed":
      if (!goal.pausedAt) throw new GoalTransitionError(event.type, "goal is not paused");
      return { ...goal, pausedAt: null };

    case "goal.retried":
      return applyRetry(goal, event);

    case "goal.reopened":
      return applyReopenPlanning(goal, event);

    case "goal.accepted":
      return acceptGoal(goal, event);

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

/**
 * A person accepts a failed goal as is: it completes with every criterion still unverified
 * waived. Only when all its work is done and merged, so the result is the integration branch as
 * it stands, and only with every unverified criterion named, so nothing is waived by accident.
 */
function acceptGoal(goal: Goal, event: Extract<GoalEvent, { type: "goal.accepted" }>): Goal {
  requireStatus(goal, event, "failed");
  const refuse = (message: string): never => {
    throw new GoalTransitionError(event.type, message);
  };
  // The clients offer the action with the same check (protocol goal/acceptance.ts).
  const refusal = acceptRefusal(goal);
  if (refusal) refuse(refusal);
  const note = event.note.trim();
  if (note.length === 0) refuse("a note saying why is required");
  if (note.length > MAX_ACCEPT_NOTE_CHARS) {
    refuse(`the note is longer than ${MAX_ACCEPT_NOTE_CHARS} characters`);
  }
  const unverified = goal.criteria.filter((c) => !c.verifiedAt).map((c) => c.id);
  const named = new Set(event.criterionIds);
  if (named.size !== event.criterionIds.length) refuse("a criterion is named twice");
  const extra = event.criterionIds.filter((id) => !unverified.includes(id));
  if (extra.length > 0) refuse(`not unverified criteria: ${extra.join(", ")}`);
  const missing = unverified.filter((id) => !named.has(id));
  if (missing.length > 0) {
    refuse(`every unverified criterion must be waived; missing: ${missing.join(", ")}`);
  }
  const waived = { at: event.at, note };
  return {
    ...goal,
    status: "completed",
    failureReason: null,
    accepted: { at: event.at, note, from: event.acceptedFrom, client: event.client },
    criteria: goal.criteria.map((c) => (named.has(c.id) ? { ...c, waived } : c)),
    // A goal paused when it failed is no longer paused once it is completed.
    ...(goal.pausedAt ? { pausedAt: null } : {}),
    ...endAppliedRecovery(goal),
  };
}

/**
 * A person retries failed or cancelled tasks. Their earlier failures stop counting
 * against maxAttempts. A failed goal is reopened only when it can still finish:
 * every failed and cancelled task is retried, no change set was rejected, and the
 * run and time limits leave room.
 */
function applyRetry(goal: Goal, event: Extract<GoalEvent, { type: "goal.retried" }>): Goal {
  if (!goal.config) {
    throw new GoalTransitionError(event.type, "a manual goal runs nothing to retry");
  }
  requireStatus(goal, event, "executing", "failed");
  if (goal.archivedAt) {
    throw new GoalTransitionError(event.type, "the goal is archived; unarchive it first");
  }
  refuseWhileRecovering(goal, event);
  const reopen = goal.status === "failed";
  if (event.reopen !== reopen) {
    throw new GoalTransitionError(
      event.type,
      reopen ? "the goal failed; a retry must reopen it" : "only a failed goal can be reopened",
    );
  }
  const reworked = event.reworkChangeSetIds ?? [];
  checkReworkReopen(goal, event, reworked, reopen);
  const retried = reopenReworks(
    retryTasks(goal, event, event.taskIds, reopen, new Set(reworked)),
    reworked,
    event.at,
  );
  return event.guidance
    ? withGuidance(retried, mergeGuidance(goal, event, event.guidance))
    : retried;
}

/**
 * A person retries the merge of change sets whose integration failed. The goal failed
 * with them, so it is reopened, and every failed and cancelled task is retried with them
 * as in a reopening goal.retried. Each change set goes back to approved: its review and
 * approval were recorded before the merge was tried, and stand.
 */
function applyIntegrationRetry(
  goal: Goal,
  event: Extract<GoalEvent, { type: "changeset.integration_retried" }>,
): Goal {
  if (!goal.config) {
    throw new GoalTransitionError(event.type, "a manual goal runs nothing to retry");
  }
  requireStatus(goal, event, "failed");
  if (goal.archivedAt) {
    throw new GoalTransitionError(event.type, "the goal is archived; unarchive it first");
  }
  refuseWhileRecovering(goal, event);
  for (const id of event.changeSetIds) {
    const cs = goal.changeSets.find((c) => c.id === id);
    if (!cs) throw new GoalTransitionError(event.type, `unknown change set ${id}`);
    if (!isIntegrationFailed(cs)) {
      throw new GoalTransitionError(
        event.type,
        `change set ${id} is ${cs.status}${cs.status === "rejected" ? " by review" : ""}; only a change set whose integration failed can be merged again`,
      );
    }
  }
  const reworked = event.reworkChangeSetIds ?? [];
  checkReworkReopen(goal, event, reworked, true);
  const retried = reopenReworks(
    retryTasks(goal, event, event.taskIds, true, new Set([...event.changeSetIds, ...reworked])),
    reworked,
    event.at,
  );
  const ids = new Set(event.changeSetIds);
  return {
    ...retried,
    changeSets: retried.changeSets.map((c) => (ids.has(c.id) ? reapprove(c, event.at) : c)),
  };
}

/**
 * The change sets a retry or recovery reworks again must each be rejected because their rework
 * failed, with a rework task to run. A reopen lists every such change set: one left rejected
 * would keep the goal from completing.
 */
function checkReworkReopen(
  goal: Goal,
  event: RetryEvent,
  ids: readonly string[],
  reopen: boolean,
): void {
  for (const id of ids) {
    const cs = goal.changeSets.find((c) => c.id === id);
    if (!cs) throw new GoalTransitionError(event.type, `unknown change set ${id}`);
    if (!isReworkFailed(cs)) {
      throw new GoalTransitionError(
        event.type,
        `change set ${id} is ${cs.status}${cs.rejectionReason ? ` (${cs.rejectionReason})` : ""}; only a change set whose rework failed can be reworked again`,
      );
    }
    if (!reworkTaskOf(goal, id)) {
      throw new GoalTransitionError(event.type, `change set ${id} has no rework task`);
    }
  }
  if (!reopen) {
    if (ids.length > 0) {
      throw new GoalTransitionError(
        event.type,
        "only a retry that reopens a failed goal reworks a change set again",
      );
    }
    return;
  }
  const missing = goal.changeSets.filter((c) => isReworkFailed(c) && !ids.includes(c.id));
  if (missing.length > 0) {
    throw new GoalTransitionError(
      event.type,
      `reopening needs every change set whose rework failed reworked again; missing ${missing.map((c) => c.id).join(", ")}`,
    );
  }
}

function reworkTaskOf(goal: Goal, changeSetId: string): Task | undefined {
  return goal.tasks.findLast((t) => t.rework?.changeSetId === changeSetId);
}

/**
 * Each change set goes back to the status it waited for its rework in, keeping its round,
 * findings and worktree; its rework task, retried with it, runs again and supersedes it.
 */
function reopenReworks(goal: Goal, ids: readonly string[], at: string): Goal {
  if (ids.length === 0) return goal;
  const reopened = new Set(ids);
  return {
    ...goal,
    changeSets: goal.changeSets.map((c) => {
      const task = reopened.has(c.id) ? reworkTaskOf(goal, c.id) : undefined;
      if (!task?.rework) return c;
      const { rejectionReason: _reason, ...rest } = c;
      return { ...rest, status: statusForRework(task.rework.reason), error: null, updatedAt: at };
    }),
  };
}

/** Back to approved, as before the merge was tried; the failure's error and reason go. */
function reapprove(cs: ChangeSet, at: string): ChangeSet {
  const { rejectionReason: _reason, ...rest } = cs;
  return { ...rest, status: "approved", error: null, updatedAt: at };
}

/**
 * The events that put a goal back to work; each may restart its time limit. recovery.started
 * checks, without applying, that its recovery could restart it.
 */
type RetryEvent = Extract<
  GoalEvent,
  {
    type:
      | "goal.retried"
      | "goal.reopened"
      | "changeset.integration_retried"
      | "recovery.started"
      | "recovery.resolved";
  }
>;

/**
 * Return tasks to pending; on a reopen, check the goal can still finish. `reopenedChangeSetIds`
 * are rejected change sets the event merges or reworks again.
 */
function retryTasks(
  goal: Goal,
  event: RetryEvent,
  taskIds: readonly string[],
  reopen: boolean,
  reopenedChangeSetIds: ReadonlySet<string>,
): Goal {
  const retryable = new Set(
    goal.tasks.filter((t) => t.status === "failed" || t.status === "cancelled").map((t) => t.id),
  );
  for (const id of taskIds) {
    if (!retryable.has(id)) {
      const known = goal.tasks.find((t) => t.id === id);
      throw new GoalTransitionError(
        event.type,
        known
          ? `task ${id} is ${known.status}, expected failed or cancelled`
          : `unknown task ${id}`,
      );
    }
  }
  const timeBase = assertRoomToRun(goal, event);
  if (reopen) {
    const missing = [...retryable].filter((id) => !taskIds.includes(id));
    if (missing.length > 0) {
      throw new GoalTransitionError(
        event.type,
        `reopening needs every failed or cancelled task retried; missing ${missing.join(", ")}`,
      );
    }
    const rejected = goal.changeSets.filter(
      (c) => c.status === "rejected" && !reopenedChangeSetIds.has(c.id),
    );
    if (rejected.length > 0) {
      throw new GoalTransitionError(
        event.type,
        `change set ${rejected.map((c) => c.id).join(", ")} was rejected, so the goal cannot complete`,
      );
    }
  }
  const retried = new Set(taskIds);
  const failedRuns = (taskId: string) =>
    goal.runs.filter((r) => r.taskId === taskId && r.status === "failed").length;
  return {
    ...goal,
    ...supersedeForRetry(goal, retried, event),
    ...timeBase,
    status: "executing",
    failureReason: reopen ? null : goal.failureReason,
    ...(reopen ? { reopens: (goal.reopens ?? 0) + 1 } : {}),
    // A reopened goal that ends again needs attention again.
    ...(reopen && goal.acknowledgedAt ? { acknowledgedAt: null } : {}),
    tasks: goal.tasks.map((t) =>
      retried.has(t.id)
        ? { ...t, status: "pending", error: null, forgivenFailures: failedRuns(t.id) }
        : t,
    ),
  };
}

/**
 * The run limit, time limit and budgets must leave room before work starts again. Returns
 * the goal's new time base when the event chose a time mode, else nothing: the time limit
 * keeps counting as before.
 */
function assertRoomToRun(goal: Goal, event: RetryEvent): Pick<Goal, "timeBaseAt"> {
  const { maxRuns } = resolveLimits(goal.config);
  if (goal.runs.length >= maxRuns) {
    throw new GoalTransitionError(event.type, `the run limit of ${maxRuns} is used up`);
  }
  const timeBase = restartTimeLimit(goal, event);
  const overBudget = budgetExceeded(goal);
  if (overBudget) throw new GoalTransitionError(event.type, overBudget);
  return timeBase;
}

/**
 * The time base a retry sets. `fresh` counts the full time limit from the event; `remaining`
 * counts it from as long before the event as the goal already ran (`activeMs`, recorded on
 * the event), so editing the limit later moves the deadline the same way. Budgets are not
 * time and stay cumulative. Neither mode moves an absolute deadline.
 */
function restartTimeLimit(goal: Goal, event: RetryEvent): Pick<Goal, "timeBaseAt"> {
  const at = Date.parse(event.at);
  const absolute = absoluteDeadlineMs(goal);
  if (absolute !== null && at >= absolute) {
    throw new GoalTransitionError(
      event.type,
      `the goal's deadline ${goal.config?.limits?.deadlineAt} has passed; set a later deadline or clear it`,
    );
  }
  const { timeMode } = event;
  if (timeMode === undefined) {
    if (at >= goalDeadlineMs(goal, at)) {
      throw new GoalTransitionError(
        event.type,
        `${GOAL_TIME_LIMIT_PASSED}; choose time mode fresh (the full limit from now) or remaining (the limit minus the time the goal ran)`,
      );
    }
    return {};
  }
  if (timeMode === "fresh") return { timeBaseAt: event.at };
  if (timeMode !== "remaining") {
    throw new GoalTransitionError(
      event.type,
      `unknown time mode ${timeMode}; expected ${GOAL_TIME_MODES.join(" or ")}`,
    );
  }
  if (event.activeMs === undefined) {
    throw new GoalTransitionError(event.type, "the remaining time mode needs activeMs");
  }
  if (event.activeMs > at - Date.parse(goal.createdAt)) {
    throw new GoalTransitionError(event.type, "activeMs is longer than the goal has existed");
  }
  if (event.activeMs >= resolveLimits(goal.config).goalTimeoutMs) {
    throw new GoalTransitionError(event.type, "no time is left; choose fresh or raise the limit");
  }
  return { timeBaseAt: new Date(at - event.activeMs).toISOString() };
}

/**
 * A person reopens a goal that failed while planning: it has no tasks, so there is
 * nothing to retry. It goes back to planning and a fresh Lead plans; the limits must
 * leave room, as for any reopen.
 */
function applyReopenPlanning(
  goal: Goal,
  event: Extract<GoalEvent, { type: "goal.reopened" }>,
): Goal {
  if (!goal.config) {
    throw new GoalTransitionError(event.type, "a manual goal runs nothing to reopen");
  }
  requireStatus(goal, event, "failed");
  if (goal.archivedAt) {
    throw new GoalTransitionError(event.type, "the goal is archived; unarchive it first");
  }
  refuseWhileRecovering(goal, event);
  if (goal.tasks.length > 0) {
    throw new GoalTransitionError(
      event.type,
      "the goal failed after planning; retry its tasks instead",
    );
  }
  const timeBase = assertRoomToRun(goal, event);
  return {
    ...goal,
    ...timeBase,
    status: "planning",
    failureReason: null,
    reopens: (goal.reopens ?? 0) + 1,
    ...(goal.acknowledgedAt ? { acknowledgedAt: null } : {}),
  };
}

function applyRecoveryEvent(goal: Goal, event: GoalEvent): Goal {
  switch (event.type) {
    case "recovery.started":
      return startRecovery(goal, event);
    case "recovery.decided":
      return decideRecovery(goal, event);
    case "recovery.resolved":
      return resolveRecovery(goal, event);
    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

/** The goal with `guidance`, or without the field when there is none. */
function withGuidance(goal: Goal, guidance: Guidance | undefined): Goal {
  if (guidance) return { ...goal, guidance };
  const { guidance: _guidance, ...rest } = goal;
  return rest;
}

function checkGuidanceText(event: GoalEvent, subject: string, text: string): void {
  if (!text.trim()) {
    throw new GoalTransitionError(
      event.type,
      `the guidance for ${subject} is empty; send null to clear it`,
    );
  }
  if (text.length > MAX_GUIDANCE_CHARS) {
    throw new GoalTransitionError(
      event.type,
      `the guidance for ${subject} has ${text.length} characters; the limit is ${MAX_GUIDANCE_CHARS}`,
    );
  }
}

/**
 * A person's guidance merged into the goal's: a string sets an entry, null clears it, absent
 * leaves it. The Lead's advice is kept apart and never changed here.
 */
function mergeGuidance(
  goal: Goal,
  event: GoalEvent,
  changes: GuidanceChanges,
): Guidance | undefined {
  const { goal: goalText, tasks: taskTexts, ...lead } = goal.guidance ?? {};
  let nextGoal = goalText;
  if (changes.goal === null) nextGoal = undefined;
  else if (changes.goal !== undefined) {
    checkGuidanceText(event, "the goal", changes.goal);
    nextGoal = changes.goal;
  }
  const tasks: Record<string, string> = { ...taskTexts };
  for (const [taskId, text] of Object.entries(changes.tasks ?? {})) {
    if (text === null) {
      delete tasks[taskId];
      continue;
    }
    if (!goal.tasks.some((t) => t.id === taskId)) {
      throw new GoalTransitionError(event.type, `guidance names unknown task ${taskId}`);
    }
    checkGuidanceText(event, `task ${taskId}`, text);
    tasks[taskId] = text;
  }
  const next: Guidance = {
    ...(nextGoal === undefined ? {} : { goal: nextGoal }),
    ...(Object.keys(tasks).length > 0 ? { tasks } : {}),
    ...lead,
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

/** The goal's recovery `recoveryId`; only the latest one can change. */
function recoveryOf(goal: Goal, event: GoalEvent, recoveryId: string): Recovery {
  const recovery = goal.recovery;
  if (recovery?.id !== recoveryId) {
    throw new GoalTransitionError(
      event.type,
      `unknown recovery ${recoveryId}${recovery ? ` (the latest is ${recovery.id})` : ""}`,
    );
  }
  return recovery;
}

function requireRecoveryStatus(event: GoalEvent, recovery: Recovery, ...allowed: string[]): void {
  if (!allowed.includes(recovery.status)) {
    throw new GoalTransitionError(
      event.type,
      `recovery ${recovery.id} is ${recovery.status}, expected ${allowed.join(" or ")}`,
    );
  }
}

/**
 * A person asks the Lead to recover a failed goal. The goal stays failed while the Lead
 * decides; nothing about its tasks, change sets or integration changes yet. A recovery that
 * could never apply is refused now: the limits must leave room as a retry's would, with the
 * time mode it chose.
 */
function startRecovery(goal: Goal, event: Extract<GoalEvent, { type: "recovery.started" }>): Goal {
  requireStatus(goal, event, "failed");
  if (!goal.config) throw new GoalTransitionError(event.type, "a manual goal has no Lead");
  if (goal.archivedAt) {
    throw new GoalTransitionError(event.type, "the goal is archived; unarchive it first");
  }
  if (goal.tasks.length === 0) {
    throw new GoalTransitionError(
      event.type,
      "the goal failed before it had a plan; retry it to plan again",
    );
  }
  const live = liveRecovery(goal);
  if (live)
    throw new GoalTransitionError(event.type, `recovery ${live.id} is still ${live.status}`);
  // An applied revise is recorded under the recovery's id, which must stay unique.
  if (
    goal.recovery?.id === event.recoveryId ||
    goal.planRevisions?.some((r) => r.id === event.recoveryId)
  ) {
    throw new GoalTransitionError(event.type, `recovery id ${event.recoveryId} was already used`);
  }
  const used = goal.recoveries ?? 0;
  if (used >= MAX_RECOVERIES) {
    throw new GoalTransitionError(
      event.type,
      `the goal was already recovered ${used} times; the limit is ${MAX_RECOVERIES}`,
    );
  }
  refuseRejectedByReview(goal, event);
  assertRoomToRun(goal, event);
  refuseDeadlineWhileDeciding(goal, event);
  const guidance = event.guidance ? mergeGuidance(goal, event, event.guidance) : goal.guidance;
  const previous = goal.recovery;
  // A recovery that ended without applying rewrote the reason and failure time; keep the ones
  // the goal first failed with. Only while that ending is still the goal's failure: a retry
  // that failed again since has a reason of its own.
  const original =
    previous?.status === "ended" &&
    previous.outcome !== "applied" &&
    previous.resolvedAt === goal.failedAt
      ? { reason: previous.failureReason, failedAt: previous.failedAt }
      : { reason: goal.failureReason ?? "", failedAt: goal.failedAt };
  const recovery: Recovery = {
    id: event.recoveryId,
    status: "deciding",
    startedAt: event.at,
    startedBy: event.startedBy,
    failureReason: original.reason,
    ...(original.failedAt === undefined ? {} : { failedAt: original.failedAt }),
    ...(event.timeMode === undefined ? {} : { timeMode: event.timeMode }),
    ...(event.activeMs === undefined ? {} : { activeMs: event.activeMs }),
  };
  return withGuidance({ ...goal, recovery }, guidance);
}

/**
 * A limit that runs out while the Lead decides would refuse the recovery when it applies, after
 * it counted. Without a time mode the time limit must outlast the decision; an absolute
 * deadline, which no time mode moves, must outlast it always.
 */
function refuseDeadlineWhileDeciding(
  goal: Goal,
  event: Extract<GoalEvent, { type: "recovery.started" }>,
): void {
  const decided = Date.parse(event.at) + RECOVERY_DECISION_MS;
  const minutes = RECOVERY_DECISION_MS / 60_000;
  const absolute = absoluteDeadlineMs(goal);
  if (absolute !== null && decided >= absolute) {
    throw new GoalTransitionError(
      event.type,
      `the goal's deadline ${goal.config?.limits?.deadlineAt} passes within the Lead's ${minutes} minutes to decide; set a later deadline or clear it`,
    );
  }
  if (event.timeMode === undefined && decided >= goalDeadlineMs(goal, Date.parse(event.at))) {
    throw new GoalTransitionError(
      event.type,
      // GOAL_TIME_LIMIT_PASSED in the text lets a client ask for a time mode, as after a retry.
      `the Lead has ${minutes} minutes to decide, and by then ${GOAL_TIME_LIMIT_PASSED}; choose time mode fresh or remaining`,
    );
  }
}

/**
 * A change set rejected by review has no way back, so the goal can never complete. One whose
 * merge or rework failed is merged or reworked again.
 */
function refuseRejectedByReview(goal: Goal, event: GoalEvent): void {
  const rejected = goal.changeSets.filter(
    (c) => c.status === "rejected" && !isIntegrationFailed(c) && !isReworkFailed(c),
  );
  if (rejected.length > 0) {
    throw new GoalTransitionError(
      event.type,
      `change set ${rejected.map((c) => c.id).join(", ")} was rejected by review, so the goal cannot complete; start a new goal from its integration branch`,
    );
  }
}

/** The recovery's Lead joins while it decides; it stays the goal's Lead once the goal reopens. */
function attachRecoveryLead(
  goal: Goal,
  event: Extract<GoalEvent, { type: "lead.attached" }>,
): Goal {
  const recovery = goal.recovery;
  if (recovery?.status !== "deciding") {
    throw new GoalTransitionError(
      event.type,
      "a failed goal takes a Lead only while a recovery decides",
    );
  }
  return {
    ...goal,
    leadAgentId: event.agentId,
    leadWorkspaceId: event.workspaceId ?? null,
    recovery: {
      ...recovery,
      leadAgentId: event.agentId,
      ...(event.workspaceId ? { leadWorkspaceId: event.workspaceId } : {}),
    },
  };
}

/** A revise is recorded as a plan revision, so it needs room among them. */
function checkRevisionRoom(goal: Goal, event: GoalEvent, decision: RecoveryDecision): void {
  const revisions = goal.planRevisions?.length ?? 0;
  if (decision.decision === "revise" && revisions >= MAX_PLAN_REVISIONS) {
    throw new GoalTransitionError(
      event.type,
      `the plan was already revised ${revisions} times; the limit is ${MAX_PLAN_REVISIONS}`,
    );
  }
}

/**
 * The Lead decided how to recover, or the Manager decided without it. A retry, or a revise the
 * goal approves on its own, is applied next by recovery.resolved; another revise waits for a
 * person; needs_person ends the recovery. Only a decision the Lead took counts toward the limit.
 */
function decideRecovery(goal: Goal, event: Extract<GoalEvent, { type: "recovery.decided" }>): Goal {
  const recovery = recoveryOf(goal, event, event.recoveryId);
  requireRecoveryStatus(event, recovery, "deciding");
  const decision: RecoveryDecision = {
    ...event.decision,
    reason: capText(event.decision.reason, MAX_DECISION_REASON_CHARS),
  };
  checkRevisionRoom(goal, event, decision);
  revisionCheck(event, () => checkRecoveryDecision(goal, decision, recovery.interventionId));
  const asked = recovery.interventionId;
  const interventions =
    asked && goal.interventions
      ? patchById(
          goal.interventions,
          new Set(
            goal.interventions
              .filter((i) => i.id === asked && i.status === "open")
              .map((i) => i.id),
          ),
          { status: "resolved", outcome: "decided", resolvedAt: event.at },
        )
      : goal.interventions;
  const decided: Recovery = {
    ...recovery,
    decision,
    decidedAt: event.at,
    counted: decision.fallback !== true,
  };
  const next: Goal = { ...goal, recovery: decided, ...(interventions ? { interventions } : {}) };
  if (decision.decision === "needs_person") {
    return endRecovery(next, "needs_person", decision.reason, event.at, decided.counted === true);
  }
  const awaiting = decision.decision === "revise" && revisionNeedsApproval(goal.config, "lead");
  return { ...next, recovery: { ...decided, status: awaiting ? "awaiting_approval" : "decided" } };
}

const ENDED_REASONS: Record<string, string> = {
  needs_person: "Recovery needs a person",
  rejected: "Recovery rejected",
  cancelled: "Recovery cancelled",
};

/**
 * The recovery ended without reopening the goal: it stays failed, now with the recovery's
 * outcome as its reason, and a recovery intervention still open is abandoned.
 */
function endRecovery(
  goal: Goal,
  outcome: string,
  reason: string | undefined,
  at: string,
  counts: boolean,
): Goal {
  const recovery = goal.recovery as Recovery;
  const prefix = ENDED_REASONS[outcome] ?? `Recovery ${outcome}`;
  const live = (goal.interventions ?? []).filter(
    (i) => i.id === recovery.interventionId && isInterventionLive(i),
  );
  return {
    ...goal,
    failureReason: reason ? `${prefix}: ${reason}` : prefix,
    failedAt: at,
    // A new ending asks for attention again, and can be dismissed again.
    ...(goal.acknowledgedAt ? { acknowledgedAt: null } : {}),
    recovery: {
      ...recovery,
      status: "ended",
      outcome,
      ...(reason ? { reason } : {}),
      resolvedAt: at,
    },
    ...(counts ? { recoveries: (goal.recoveries ?? 0) + 1 } : {}),
    ...(goal.interventions && live.length > 0
      ? {
          interventions: patchById(goal.interventions, new Set(live.map((i) => i.id)), {
            status: "abandoned",
            resolvedAt: at,
          }),
        }
      : {}),
  };
}

/** A goal reopened by a recovery that ends again ends the recovery with it. */
function endAppliedRecovery(goal: Goal): Partial<Goal> {
  if (goal.recovery?.status !== "applied") return {};
  return { recovery: { ...goal.recovery, status: "ended" } };
}

/**
 * New work from a recovery must not complete on evidence that never saw it. A decision that adds
 * or replaces a task, applied after verification started or recorded a result, clears every
 * criterion and starts the next verification round; its criterion.verified events carry the round
 * in their ids. A retry or a revise that only removes keeps the results.
 */
function withVerificationReset(goal: Goal, decision: RecoveryDecision): Goal {
  const addsWork = decision.ops?.some((op) => op.op !== "remove") === true;
  // A criterion verified without verifyStartedAt (a manual record, or a log from before stage
  // times) counts as started too: the new work must not complete on that evidence either.
  const started = goal.verifyStartedAt !== undefined || goal.criteria.some((c) => c.verifiedAt);
  if (!addsWork || !started) return goal;
  const { verifyStartedAt: _started, verifiedAt: _verified, ...rest } = goal;
  return {
    ...rest,
    criteria: goal.criteria.map((c) => ({ ...c, verifiedAt: null, evidence: null })),
    verificationRound: (goal.verificationRound ?? 0) + 1,
  };
}

/**
 * The recovery ends. "applied" reopens the goal; "rejected" (a person turned down the Lead's
 * revise), "needs_person" and "cancelled" leave it failed. A person cannot cancel while the
 * Manager applies a decision.
 */
function resolveRecovery(
  goal: Goal,
  event: Extract<GoalEvent, { type: "recovery.resolved" }>,
): Goal {
  const recovery = recoveryOf(goal, event, event.recoveryId);
  // Only a needs_person the Manager records itself can leave a Lead decision uncounted.
  if (event.uncounted !== undefined && event.outcome !== "needs_person") {
    throw new GoalTransitionError(event.type, "only a needs_person outcome can be uncounted");
  }
  if (event.outcome === "applied") {
    requireRecoveryStatus(event, recovery, "decided", "awaiting_approval");
    return applyRecovery(goal, recovery, event);
  }
  if (event.timeMode !== undefined || event.activeMs !== undefined) {
    throw new GoalTransitionError(event.type, "only an applied recovery restarts the time limit");
  }
  if (event.reworkChangeSetIds !== undefined) {
    throw new GoalTransitionError(event.type, "only an applied recovery reworks change sets again");
  }
  switch (event.outcome) {
    case "rejected":
      requireRecoveryStatus(event, recovery, "awaiting_approval");
      break;
    case "needs_person":
      requireRecoveryStatus(event, recovery, "decided", "awaiting_approval");
      break;
    case "cancelled":
      if (recovery.status === "decided") {
        throw new GoalTransitionError(
          event.type,
          "the recovery is being applied; cancel the goal after it reopens",
        );
      }
      requireRecoveryStatus(event, recovery, "deciding", "awaiting_approval");
      break;
    default:
      throw new GoalTransitionError(
        event.type,
        `unknown outcome ${event.outcome}; expected applied, rejected, needs_person or cancelled`,
      );
  }
  const reason =
    event.reason === undefined ? undefined : capText(event.reason, MAX_DECISION_REASON_CHARS);
  const counts =
    recovery.counted === true && event.outcome !== "cancelled" && event.uncounted !== true;
  return endRecovery(goal, event.outcome, reason, event.at, counts);
}

/**
 * Applies the recovery's decision in one step, checked against the goal as it is now: the
 * revise's ops (recorded as an applied plan revision), every failed and cancelled task back to
 * pending with its failures forgiven, merges that failed approved again, change sets whose rework
 * failed back to waiting for it (every one, listed on the event), the time limit
 * restarted with the recovery's time mode from this event, the Lead's advice for the workers,
 * verification started over when the revise adds work, and the goal reopened. Refused when the goal cannot run; the Manager then ends the recovery.
 */
function applyRecovery(
  goal: Goal,
  recovery: Recovery,
  event: Extract<GoalEvent, { type: "recovery.resolved" }>,
): Goal {
  if (event.timeMode !== recovery.timeMode || event.activeMs !== recovery.activeMs) {
    throw new GoalTransitionError(
      event.type,
      "the time mode and active time must be the ones the recovery started with",
    );
  }
  const decision = recovery.decision;
  if (!decision)
    throw new GoalTransitionError(event.type, `recovery ${recovery.id} has no decision`);
  checkRevisionRoom(goal, event, decision);
  const tasks = revisionCheck(event, () =>
    checkRecoveryDecision(goal, decision, recovery.interventionId),
  );
  const planRevisions = decision.ops
    ? [
        ...(goal.planRevisions ?? []),
        {
          id: recovery.id,
          source: "lead",
          reason: decision.reason,
          ops: decision.ops,
          status: "applied",
          ...(recovery.interventionId ? { interventionId: recovery.interventionId } : {}),
          proposedAt: recovery.decidedAt ?? event.at,
          decidedAt: event.at,
        } satisfies PlanRevision,
      ]
    : goal.planRevisions;
  const revised: Goal = { ...goal, tasks, ...(planRevisions ? { planRevisions } : {}) };
  refuseRejectedByReview(revised, event);
  const reworked = event.reworkChangeSetIds ?? [];
  checkReworkReopen(revised, event, reworked, true);
  const timeBase = assertRoomToRun(revised, event);
  const failedRuns = (taskId: string) =>
    goal.runs.filter((r) => r.taskId === taskId && r.status === "failed").length;
  const { lead: _lead, tasks: personTasks, ...personGuidance } = goal.guidance ?? {};
  // A person's guidance for a task the revise removed has no task left to reach.
  const kept = Object.entries(personTasks ?? {}).filter(([id]) =>
    revised.tasks.some((t) => t.id === id),
  );
  const hints = decision.hints ?? {};
  const guidance: Guidance = {
    ...personGuidance,
    ...(kept.length > 0 ? { tasks: Object.fromEntries(kept) } : {}),
    ...(Object.keys(hints).length > 0 ? { lead: { recoveryId: recovery.id, tasks: hints } } : {}),
  };
  const counted = recovery.counted === true;
  const reworkedGoal = withVerificationReset(reopenReworks(revised, reworked, event.at), decision);
  const reopened: Goal = {
    ...reworkedGoal,
    ...timeBase,
    status: "executing",
    failureReason: null,
    reopens: (goal.reopens ?? 0) + 1,
    ...(goal.acknowledgedAt ? { acknowledgedAt: null } : {}),
    tasks: reworkedGoal.tasks.map((t) =>
      t.status === "failed" || t.status === "cancelled"
        ? { ...t, status: "pending", error: null, forgivenFailures: failedRuns(t.id) }
        : t,
    ),
    changeSets: reworkedGoal.changeSets.map((c) =>
      isIntegrationFailed(c) ? reapprove(c, event.at) : c,
    ),
    ...(counted ? { recoveries: (goal.recoveries ?? 0) + 1 } : {}),
    recovery: { ...recovery, status: "applied", outcome: "applied", resolvedAt: event.at },
  };
  return withGuidance(reopened, Object.keys(guidance).length > 0 ? guidance : undefined);
}
