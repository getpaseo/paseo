import { randomUUID } from "node:crypto";
import type {
  GoalListArchivedFilter,
  GoalRetainedResource,
} from "@getpaseo/protocol/goal/rpc-schemas";
import { originalFailureReason } from "@getpaseo/protocol/goal/acceptance";
import { goalActiveMs } from "@getpaseo/protocol/goal/active-time";
import { DEFAULT_GOAL_PERMISSION_POLICY } from "@getpaseo/protocol/goal/config-bounds";
import {
  GoalConfigSchema,
  type Goal,
  type GoalConfig,
  type GoalConfigChanges,
  type GoalEvent,
  type GoalEventInput,
  type GoalPriority,
  type GoalStatus,
  type GuidanceChanges,
  type PlanRevisionOp,
  type Recovery,
  type TaskSpec,
} from "@getpaseo/protocol/goal/types";
import type { GoalEventLog } from "./event-log.js";
import type { GoalConfigUpdateValidator, GoalConfigValidator } from "./goal-config-validation.js";
import { goalPriority, sortGoalsByPriority } from "./goal-priority.js";
import {
  GoalTransitionError,
  isIntegrationFailed,
  isTerminalGoalStatus,
  liveRecovery,
} from "./goal-reducer.js";
import {
  decisionNoLongerFits,
  recoveryTimeFields,
  reworkChangeSetFields,
} from "./goal-recovery.js";
import type { GoalRemovedListener, GoalStore, GoalStoreListener } from "./goal-store.js";
import {
  PlanRevisionError,
  diffDesiredPlan,
  revisionNeedsApproval,
  validatePlanRevision,
  type PlanRevisionSource,
} from "./plan-revision.js";

/** Client ids are namespaced so they cannot collide with the Manager's own event ids. */
function clientEventId(type: string, target: string, eventId: string): string {
  return `client:${type}:${target}:${eventId}`;
}

export class GoalNotFoundError extends Error {
  constructor(public readonly goalId: string) {
    super(`Goal ${goalId} not found`);
    this.name = "GoalNotFoundError";
  }
}

export interface CreateGoalInput {
  goalId?: string;
  title: string;
  objective: string;
  criteria: string[];
  config?: GoalConfig | null;
  priority?: GoalPriority;
}

/** What the service asks of the Manager before reopening or deleting a goal. */
export interface GoalActivityProbe {
  hasLiveWork(goalId: string): boolean;
  /** Remove what a deleted goal created; returns what was left in place. Never throws. */
  releaseResources?(goal: Goal): Promise<GoalRetainedResource[]>;
  /** Provider and thinking checks on specs a revision adds or replaces. Throws PlanRevisionError. */
  checkPlanSpecs?(goal: Goal, specs: readonly TaskSpec[]): Promise<void>;
  /** Approve a revision whose automatic approval did not happen; throws why it failed. */
  approveRevisionNow?(goalId: string, revisionId: string): Promise<void>;
  /** Why the goal's integration worktree cannot take a recovery now, or null. */
  integrationProblem?(goal: Goal): Promise<string | null>;
  /** Why a change set whose rework failed cannot be reworked again (its worktree is gone), or null. */
  reworkWorktreeProblem?(goal: Goal): Promise<string | null>;
}

/**
 * A person's instruction for a recovery or a retry. `prompt` is for the whole goal and
 * `tasks` for one task each; a string sets it, null clears it. `agentId` is set when an agent
 * asks, which is refused: only a person starts a recovery or gives guidance.
 */
export interface GuidanceInput {
  prompt?: string | null;
  tasks?: Record<string, string | null>;
  agentId?: string;
}

export interface RecoveryStartInput extends GuidanceInput {
  /** How the time limit restarts when the recovery applies; see GOAL_TIME_MODES. */
  timeMode?: string;
}

/**
 * A person accepts a failed goal as is. `criterionIds` names every criterion still unverified;
 * `note` says why. `client` records where it came from ("app" or "cli"). `agentId` is set when an
 * agent asks, which is refused.
 */
export interface AcceptGoalInput {
  criterionIds: string[];
  note: string;
  client?: string;
  agentId?: string;
}

export interface RecoveryDecisionInput {
  recoveryId: string;
  approve: boolean;
  /** Why a person rejected the Lead's revise. */
  message?: string;
  agentId?: string;
}

/**
 * A change to an executing goal's plan: `ops`, or the desired plan as `tasks` with `remove`
 * naming each pending, failed or cancelled task left out. `agentId` is the caller's agent,
 * when an agent asks; only the goal's Lead may.
 */
export interface PlanRevisionInput {
  ops?: PlanRevisionOp[];
  tasks?: TaskSpec[];
  remove?: string[];
  reason: string;
  agentId?: string;
}

/** goal.list filters. Every one is optional; they combine with AND. */
export interface GoalListFilter {
  query?: string;
  status?: readonly GoalStatus[];
  priority?: readonly GoalPriority[];
  cwd?: string;
  /** Absent hides archived goals. */
  archived?: GoalListArchivedFilter;
}

export interface GoalDeletion {
  goalId: string;
  /** False when there was no such goal, for example on a repeated delete. */
  deleted: boolean;
  retained: GoalRetainedResource[];
}

/** Every filter in `filter` holds for the goal. */
export function matchesGoalFilter(goal: Goal, filter: GoalListFilter): boolean {
  const archived = filter.archived ?? "exclude";
  if (archived === "exclude" && goal.archivedAt) return false;
  if (archived === "only" && !goal.archivedAt) return false;
  if (filter.status && !filter.status.includes(goal.status)) return false;
  if (filter.priority && !filter.priority.includes(goalPriority(goal))) return false;
  if (filter.cwd !== undefined && goal.config?.cwd !== filter.cwd) return false;
  const query = filter.query?.trim().toLowerCase();
  if (query) {
    const haystack = [goal.title, goal.objective, goal.id];
    if (!haystack.some((text) => text.toLowerCase().includes(query))) return false;
  }
  return true;
}

export interface GoalInspection {
  goal: Goal;
  events: GoalEvent[];
}

/**
 * The Manager's command surface. It turns requests into events and never
 * decides anything itself; legality lives in the reducer.
 */
export class GoalService {
  private activity: GoalActivityProbe | null = null;

  constructor(
    private readonly store: GoalStore,
    private readonly log: GoalEventLog,
    private readonly validateConfig?: GoalConfigValidator,
    private readonly validateConfigUpdate?: GoalConfigUpdateValidator,
    /** Epoch milliseconds; tests pass the clock the log uses. */
    private readonly now: () => number = Date.now,
  ) {}

  /** The Manager is built after the service; it reports whether a goal still has work stopping. */
  attachActivityProbe(probe: GoalActivityProbe): void {
    this.activity = probe;
  }

  async start(): Promise<void> {
    await this.store.recover();
  }

  /** Matching goals, higher priority first, then oldest first. Archived ones are hidden by default. */
  list(filter: GoalListFilter = {}): Goal[] {
    return sortGoalsByPriority(this.store.list().filter((goal) => matchesGoalFilter(goal, filter)));
  }

  /** Called after each event is recorded; returns the unsubscribe. */
  subscribe(listener: GoalStoreListener): () => void {
    return this.store.subscribe(listener);
  }

  /** Called once per deleted goal with its last state; returns the unsubscribe. */
  subscribeRemoved(listener: GoalRemovedListener): () => void {
    return this.store.subscribeRemoved(listener);
  }

  async inspect(goalId: string): Promise<GoalInspection> {
    const goal = this.requireGoal(goalId);
    return { goal, events: await this.log.read(goalId) };
  }

  async create(input: CreateGoalInput): Promise<Goal> {
    // Completion rests on verified criteria; without any, there would be nothing to verify.
    if (input.config && input.criteria.length === 0) {
      throw new Error("A managed goal needs at least one acceptance criterion");
    }
    const validated = input.config
      ? ((await this.validateConfig?.(input.config)) ?? input.config)
      : null;
    // Defaults are recorded, so a later change of default leaves this goal as it was. Goals
    // stored without leadInterventions read as off; new ones get it unless asked not to.
    const config = validated
      ? {
          ...validated,
          onPermissionRequest: validated.onPermissionRequest ?? DEFAULT_GOAL_PERMISSION_POLICY,
          leadInterventions: validated.leadInterventions ?? true,
        }
      : null;
    const goalId = input.goalId ?? randomUUID();
    const { goal } = await this.store.dispatch(goalId, {
      // Derived from the goal id so a retried create is a duplicate, not a second goal.
      id: `${goalId}:created`,
      goalId,
      type: "goal.created",
      title: input.title,
      objective: input.objective,
      criteria: input.criteria.map((text, index) => ({ id: `c${index + 1}`, text })),
      ...(config ? { config } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
    });
    return goal;
  }

  /** Allowed in any state. The same title again returns the goal unchanged. */
  async rename(goalId: string, title: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.renamed", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const trimmed = title.trim();
    if (!trimmed) throw new Error("A goal title cannot be empty");
    const goal = this.requireGoal(goalId);
    if (goal.title === trimmed) return goal;
    return this.dispatch(goalId, eventId, { type: "goal.renamed", title: trimmed });
  }

  /**
   * Change a managed goal's settings, in any state but archived. The changes are merged
   * into the current config and checked as on create. A live goal picks them up at its
   * next turn or run. The same settings again return the goal unchanged.
   */
  async updateConfig(goalId: string, changes: GoalConfigChanges, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.config_updated", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireManaged(goalId, "change");
    if (goal.archivedAt) {
      throw new Error(`Goal ${goalId} is archived; unarchive it before changing its settings`);
    }
    const previous = goal.config as GoalConfig;
    const parsed = GoalConfigSchema.safeParse(mergeConfigChanges(previous, changes));
    if (!parsed.success) {
      throw new Error(`Invalid goal settings: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
    const next = parsed.data;
    if (stableJson(next) === stableJson(previous)) return goal;
    await this.validateConfigUpdate?.(next, previous);
    return this.dispatch(goalId, eventId, { type: "goal.config_updated", config: next });
  }

  /** Allowed in any state. The current priority again returns the goal unchanged. */
  async setPriority(goalId: string, priority: GoalPriority, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.priority_set", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireGoal(goalId);
    if (goalPriority(goal) === priority) return goal;
    return this.dispatch(goalId, eventId, { type: "goal.priority_set", priority });
  }

  /** Only an ended goal can be archived. Archiving twice returns the goal unchanged. */
  async archive(goalId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.archived", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireEnded(goalId, "archived");
    if (goal.archivedAt) return goal;
    return this.dispatch(goalId, eventId, { type: "goal.archived" });
  }

  /** Unarchiving a goal that is not archived returns it unchanged. */
  async unarchive(goalId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.unarchived", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireGoal(goalId);
    if (!goal.archivedAt) return goal;
    return this.dispatch(goalId, eventId, { type: "goal.unarchived" });
  }

  /**
   * Delete an ended goal for good. Its log is tombstoned first, in one atomic rename,
   * so a crash leaves the goal either whole or marked deleted; the worktrees it created
   * are removed next, and the tombstone last. A restart finishes a deletion that a crash
   * interrupted. Deleting a goal that does not exist succeeds with `deleted: false`.
   */
  async delete(goalId: string): Promise<GoalDeletion> {
    if (this.store.get(goalId)) refuseWhileRecovering(this.requireEnded(goalId, "deleted"));
    const removed = await this.store.remove(goalId, (goal) => {
      if (!isTerminalGoalStatus(goal.status)) {
        throw new Error(`Goal ${goalId} is ${goal.status}; stop it before it can be deleted`);
      }
      refuseWhileRecovering(goal);
      if (this.activity?.hasLiveWork(goalId)) {
        throw new Error("The goal's agents are still stopping; delete again in a moment");
      }
    });
    if (!removed) return { goalId, deleted: false, retained: [] };
    const retained = (await this.activity?.releaseResources?.(removed)) ?? [];
    await this.store.removeTombstone(goalId);
    return { goalId, deleted: true, retained };
  }

  async proposePlan(goalId: string, tasks: TaskSpec[], eventId?: string): Promise<Goal> {
    // A managed goal's plan comes from its Lead, which is checked against the goal's
    // providers and limits; a hand-written plan would skip those checks.
    if (this.requireGoal(goalId).config) {
      throw new Error("This goal's plan comes from its Lead and cannot be proposed by hand");
    }
    return this.dispatch(goalId, eventId, { type: "plan.proposed", tasks });
  }

  approvePlan(goalId: string, eventId?: string): Promise<Goal> {
    return this.dispatch(goalId, eventId, { type: "plan.approved" });
  }

  /**
   * Propose a change to an executing goal's plan. Who proposes decides approval, not access:
   * no agent id is a person, whose revision applies at once; the goal's Lead waits for a
   * person unless plans auto-approve. The Manager makes that approval, never the service, and
   * the reply waits for it, so it shows the decided revision.
   */
  async revisePlan(goalId: string, input: PlanRevisionInput, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "plan.revision_proposed", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireManaged(goalId, "revise");
    const source = revisionSource(goal, input.agentId);
    const ops = revisionOps(goal, input);
    validatePlanRevision(goal, ops, source);
    const specs = ops.flatMap((op) => (op.op === "remove" ? [] : [op.task]));
    await this.activity?.checkPlanSpecs?.(goal, specs);
    // Prefixed so it never matches an id the Manager derives from a task and attempt.
    const revisionId = `rev-${eventId ?? randomUUID()}`;
    await this.dispatch(goalId, eventId, {
      type: "plan.revision_proposed",
      revisionId,
      source,
      reason: input.reason.trim(),
      ops,
    });
    await this.store.whenIdle(goalId);
    await this.ensureDecided(goalId, revisionId);
    return this.requireGoal(goalId);
  }

  /**
   * A revision that needs no approval is decided by the Manager as it is recorded. If it is
   * still pending (that reaction failed), ask once more, and otherwise say so rather than
   * report success for a change that is not applied.
   */
  private async ensureDecided(goalId: string, revisionId: string): Promise<void> {
    const pending = () => {
      const goal = this.requireGoal(goalId);
      const revision = goal.planRevisions?.find((r) => r.id === revisionId);
      return revision?.status === "pending" && !revisionNeedsApproval(goal.config, revision.source);
    };
    if (!pending()) return;
    await this.activity?.approveRevisionNow?.(goalId, revisionId);
    if (pending()) {
      throw new Error(
        `Plan revision ${revisionId} was recorded but not applied; it is approved when the daemon restarts`,
      );
    }
  }

  /** A person approves a revision held for approval. */
  async approvePlanRevision(goalId: string, revisionId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "plan.revision_approved", revisionId, eventId)) {
      return this.requireGoal(goalId);
    }
    this.requirePendingRevision(goalId, revisionId);
    return this.dispatch(goalId, eventId, {
      type: "plan.revision_approved",
      revisionId,
      target: revisionId,
    });
  }

  /** A person rejects a revision held for approval; the plan stays as it was. */
  async rejectPlanRevision(
    goalId: string,
    revisionId: string,
    feedback: string | undefined,
    eventId?: string,
  ): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "plan.revision_rejected", revisionId, eventId)) {
      return this.requireGoal(goalId);
    }
    this.requirePendingRevision(goalId, revisionId);
    return this.dispatch(goalId, eventId, {
      type: "plan.revision_rejected",
      revisionId,
      reason: feedback?.trim() ?? "",
      target: revisionId,
    });
  }

  private requirePendingRevision(goalId: string, revisionId: string): void {
    const revision = this.requireGoal(goalId).planRevisions?.find((r) => r.id === revisionId);
    if (!revision) {
      throw new Error(`Plan revision ${revisionId} not found in goal ${goalId}`);
    }
    if (revision.status !== "pending") {
      throw new Error(
        `Plan revision ${revisionId} is ${revision.status}; only a pending one can be decided`,
      );
    }
  }

  /** A person releases a reviewed change set that is held for human approval. */
  async approveChangeSet(goalId: string, changeSetId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "changeset.transitioned", changeSetId, eventId)) {
      return this.requireGoal(goalId);
    }
    const changeSet = this.requireGoal(goalId).changeSets.find((c) => c.id === changeSetId);
    if (!changeSet) {
      throw new Error(`Change set ${changeSetId} not found in goal ${goalId}`);
    }
    if (changeSet.status !== "awaiting_human") {
      throw new Error(
        `Change set ${changeSetId} is ${changeSet.status}; only a reviewed change set held for approval can be approved`,
      );
    }
    return this.dispatch(goalId, eventId, {
      type: "changeset.transitioned",
      changeSetId,
      to: "approved",
    });
  }

  /** A person sends a change set held for approval back to its author. */
  async requestChanges(
    goalId: string,
    changeSetId: string,
    findings: string,
    eventId?: string,
  ): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "changeset.transitioned", changeSetId, eventId)) {
      return this.requireGoal(goalId);
    }
    const changeSet = this.requireGoal(goalId).changeSets.find((c) => c.id === changeSetId);
    if (!changeSet) {
      throw new Error(`Change set ${changeSetId} not found in goal ${goalId}`);
    }
    if (changeSet.status !== "awaiting_human") {
      throw new Error(
        `Change set ${changeSetId} is ${changeSet.status}; changes can only be requested while it is held for approval`,
      );
    }
    return this.dispatch(goalId, eventId, {
      type: "changeset.transitioned",
      changeSetId,
      to: "changes_requested",
      findings: `- ${findings}`,
    });
  }

  cancel(goalId: string, eventId?: string): Promise<Goal> {
    return this.dispatch(goalId, eventId, { type: "goal.cancelled" });
  }

  /** A person sends the proposed plan back; the Lead plans again with the feedback. */
  rejectPlan(goalId: string, feedback: string | undefined, eventId?: string): Promise<Goal> {
    return this.dispatch(goalId, eventId, {
      type: "plan.rejected",
      reason: feedback?.trim() ?? "",
    });
  }

  /** Stop new worker runs from starting. Runs already going finish normally. */
  async pause(goalId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.paused", "", eventId)) {
      return this.requireGoal(goalId);
    }
    this.requireManaged(goalId, "pause");
    return this.dispatch(goalId, eventId, { type: "goal.paused" });
  }

  async resume(goalId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.resumed", "", eventId)) {
      return this.requireGoal(goalId);
    }
    this.requireManaged(goalId, "resume");
    return this.dispatch(goalId, eventId, { type: "goal.resumed" });
  }

  /**
   * Retry one failed or cancelled task, or all of them. A failed goal is reopened,
   * and then every failed and cancelled task is retried whichever one is named. A goal
   * that failed while planning has no tasks; it is reopened and a fresh Lead plans.
   * `timeMode` restarts the time limit (see GOAL_TIME_MODES); the reducer checks it.
   */
  async retry(
    goalId: string,
    taskId: string | undefined,
    eventId?: string,
    timeMode?: string,
    guidanceInput: GuidanceInput = {},
  ): Promise<Goal> {
    if (await this.retriedBefore(goalId, taskId, eventId)) return this.requireGoal(goalId);
    const guidance = guidanceChanges(guidanceInput);
    if (guidance) refuseAgent(guidanceInput.agentId, "give guidance");
    const goal = this.requireManaged(goalId, "retry");
    refuseWhileRecovering(goal);
    const time = await this.retryTime(goalId, timeMode);
    if (goal.status === "failed" && goal.tasks.length === 0) {
      if (taskId) throw new Error(`Task ${taskId} not found in goal ${goalId}`);
      if (guidance) {
        throw new Error(
          `Goal ${goalId} failed before it had a plan, so there are no workers to guide; retry without guidance`,
        );
      }
      this.requireSettled(goalId);
      return this.dispatch(goalId, eventId, { type: "goal.reopened", ...time });
    }
    const retryable = retryableTaskIds(goal, taskId);
    const reopen = goal.status === "failed";
    // A failed goal's change sets whose merge failed are merged again, oldest first, and those
    // whose rework failed are reworked again, with every failed and cancelled task. Change sets
    // rejected by review stay rejected.
    const remerge = reopen ? goal.changeSets.filter(isIntegrationFailed).map((c) => c.id) : [];
    if (retryable.length === 0 && remerge.length === 0) {
      throw new Error(
        reopen
          ? `Goal ${goalId} has no failed or cancelled task, no change set rejected by a failed integration and no failed rework to retry`
          : `Goal ${goalId} has no failed or cancelled task to retry`,
      );
    }
    if (reopen) this.requireSettled(goalId);
    const rework = await this.reworkToReopen(goal, reopen);
    if (remerge.length > 0) {
      if (guidance) {
        throw new Error(
          `This retry merges again ${remerge.join(", ")}, which takes no guidance; retry without it, or recover the goal: paseo goal recover ${goalId}`,
        );
      }
      return this.dispatch(goalId, eventId, {
        type: "changeset.integration_retried",
        changeSetIds: remerge,
        taskIds: retryable,
        target: "",
        ...time,
        ...rework,
      });
    }
    return this.dispatch(goalId, eventId, {
      type: "goal.retried",
      taskIds: reopen || !taskId ? retryable : [taskId],
      reopen,
      target: taskId ?? "",
      ...time,
      ...(guidance ? { guidance } : {}),
      ...rework,
    });
  }

  /**
   * On a reopen, the change sets whose rework failed, to be reworked again. Refused while one's
   * worktree is gone: the reducer cannot see the disk, and the rework would only fail again.
   */
  private async reworkToReopen(
    goal: Goal,
    reopen: boolean,
  ): Promise<{ reworkChangeSetIds?: string[] }> {
    const rework = reopen ? reworkChangeSetFields(goal) : {};
    if (!rework.reworkChangeSetIds) return rework;
    const problem = await this.reworkProblem(goal, "retry");
    if (problem) throw new Error(problem);
    return rework;
  }

  /**
   * Why a change set whose rework failed cannot be reworked again, or null when there is none.
   * Refused, not passed, while the Manager cannot check yet.
   */
  private async reworkProblem(goal: Goal, verb: string): Promise<string | null> {
    if (!reworkChangeSetFields(goal).reworkChangeSetIds) return null;
    if (!this.activity?.reworkWorktreeProblem) {
      throw new Error(`The daemon cannot check the rework worktree yet; ${verb} again in a moment`);
    }
    return this.activity.reworkWorktreeProblem(goal);
  }

  /**
   * A person asks the goal's Lead to recover a failed goal. The goal stays failed while a fresh
   * Lead decides; the Manager starts it and applies its decision. `timeMode` restarts the time
   * limit when the recovery applies; with `remaining`, the time the goal ran is read from its
   * log now and recorded. Refused when an agent asks.
   */
  async startRecovery(goalId: string, input: RecoveryStartInput, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "recovery.started", "", eventId)) {
      return this.requireGoal(goalId);
    }
    refuseAgent(input.agentId, "start a recovery");
    const goal = this.requireManaged(goalId, "recover");
    refuseWhileRecovering(goal);
    if (goal.status === "failed") {
      this.requireSettled(goalId, "recover");
      // Checked before anything is recorded, so a broken worktree is refused, not counted as a
      // recovery that ended at once. The Manager checks again after a restart and before applying.
      const problem =
        (await this.activity?.integrationProblem?.(goal)) ??
        (await this.reworkProblem(goal, "recover"));
      if (problem) throw new Error(problem);
    }
    const time = await this.retryTime(goalId, input.timeMode);
    const guidance = guidanceChanges(input);
    // The seq the event takes: unique in the goal, and never an id a revision or task uses.
    const recoveryId = `rec-${goal.lastSeq + 1}`;
    const { goal: started } = await this.store.dispatch(goalId, {
      id: eventId
        ? clientEventId("recovery.started", "", eventId)
        : `${goalId}:recovery:${goal.lastSeq}`,
      goalId,
      type: "recovery.started",
      recoveryId,
      startedBy: "person",
      ...time,
      ...(guidance ? { guidance } : {}),
    });
    return started;
  }

  /**
   * A person decides a recovery whose revise waits for approval. An approval checks the
   * integration worktree again, then applies; a problem there or a refused apply ends the
   * recovery for a person, counted only when the Lead's decision no longer fits the goal.
   */
  async decideRecovery(
    goalId: string,
    input: RecoveryDecisionInput,
    eventId?: string,
  ): Promise<Goal> {
    const { recoveryId } = input;
    if (
      (await this.alreadyApplied(goalId, "recovery.resolved", recoveryId, eventId)) ||
      (await this.alreadyApplied(goalId, "recovery.resolved", `${recoveryId}:refused`, eventId))
    ) {
      return this.requireGoal(goalId);
    }
    refuseAgent(input.agentId, "decide a recovery");
    const recovery = this.requireRecovery(goalId, recoveryId);
    if (recovery.status !== "awaiting_approval") {
      throw new Error(
        `Recovery ${recoveryId} is ${recovery.status}; only a recovery waiting for approval can be approved or rejected`,
      );
    }
    if (!input.approve) {
      const reason = input.message?.trim();
      return this.dispatch(goalId, eventId, {
        type: "recovery.resolved",
        recoveryId,
        outcome: "rejected",
        ...(reason ? { reason } : {}),
        target: recoveryId,
      });
    }
    if (!this.activity?.integrationProblem) {
      throw new Error(
        "The daemon cannot check the integration worktree yet; approve again in a moment",
      );
    }
    const problem =
      (await this.activity.integrationProblem(this.requireGoal(goalId))) ??
      (await this.reworkProblem(this.requireGoal(goalId), "approve"));
    if (problem) return this.refuseRecovery(goalId, recoveryId, problem, true, eventId);
    try {
      return await this.dispatch(goalId, eventId, {
        type: "recovery.resolved",
        recoveryId,
        outcome: "applied",
        ...recoveryTimeFields(recovery),
        ...reworkChangeSetFields(this.requireGoal(goalId)),
        target: recoveryId,
      });
    } catch (error) {
      if (!(error instanceof GoalTransitionError)) throw error;
      const current = this.requireGoal(goalId);
      if (current.recovery?.id !== recoveryId || current.recovery.status !== "awaiting_approval") {
        throw error;
      }
      return this.refuseRecovery(
        goalId,
        recoveryId,
        `The recovery could not be applied: ${error.message}`,
        !decisionNoLongerFits(current, current.recovery),
        eventId,
      );
    }
  }

  private refuseRecovery(
    goalId: string,
    recoveryId: string,
    reason: string,
    uncounted: boolean,
    eventId: string | undefined,
  ): Promise<Goal> {
    return this.dispatch(goalId, eventId, {
      type: "recovery.resolved",
      recoveryId,
      outcome: "needs_person",
      reason,
      ...(uncounted ? { uncounted: true } : {}),
      target: `${recoveryId}:refused`,
    });
  }

  /**
   * A person stops a recovery that is deciding or waiting for approval; the goal stays failed.
   * Refused while the Manager applies a decision.
   */
  async cancelRecovery(
    goalId: string,
    input: { recoveryId: string; agentId?: string },
    eventId?: string,
  ): Promise<Goal> {
    const { recoveryId } = input;
    if (await this.alreadyApplied(goalId, "recovery.resolved", recoveryId, eventId)) {
      return this.requireGoal(goalId);
    }
    refuseAgent(input.agentId, "cancel a recovery");
    const recovery = this.requireRecovery(goalId, recoveryId);
    if (recovery.status === "applied" || recovery.status === "ended") {
      throw new Error(
        `Recovery ${recoveryId} already ended (${recovery.outcome ?? recovery.status}); there is nothing to cancel`,
      );
    }
    return this.dispatch(goalId, eventId, {
      type: "recovery.resolved",
      recoveryId,
      outcome: "cancelled",
      target: recoveryId,
    });
  }

  private requireRecovery(goalId: string, recoveryId: string): Recovery {
    const recovery = this.requireManaged(goalId, "recover").recovery;
    if (recovery?.id !== recoveryId) {
      throw new Error(
        recovery
          ? `Recovery ${recoveryId} not found in goal ${goalId}; its latest recovery is ${recovery.id}`
          : `Goal ${goalId} has no recovery`,
      );
    }
    return recovery;
  }

  /**
   * The time fields of a retry event. With `remaining`, the time the goal ran is read from
   * its log now and recorded on the event, so replaying the log never recomputes it.
   */
  private async retryTime(
    goalId: string,
    timeMode: string | undefined,
  ): Promise<{ timeMode?: string; activeMs?: number }> {
    if (timeMode === undefined) return {};
    if (timeMode !== "remaining") return { timeMode };
    // Read before the event is appended, so a live goal's running time stops short of the
    // event's own time by the few milliseconds the append takes; a stopped goal's is exact.
    const activeMs = Math.round(goalActiveMs(await this.log.read(goalId), this.now()));
    if (!Number.isFinite(activeMs)) {
      throw new Error(`Goal ${goalId}'s running time could not be read from its log`);
    }
    return { timeMode, activeMs };
  }

  private async retriedBefore(
    goalId: string,
    taskId: string | undefined,
    eventId: string | undefined,
  ): Promise<boolean> {
    return (
      (await this.alreadyApplied(goalId, "goal.retried", taskId ?? "", eventId)) ||
      (await this.alreadyApplied(goalId, "goal.reopened", "", eventId)) ||
      (await this.alreadyApplied(goalId, "changeset.integration_retried", "", eventId))
    );
  }

  /** A failed goal is reopened only once the work it left stopping has ended. */
  private requireSettled(goalId: string, verb = "retry"): void {
    if (this.activity?.hasLiveWork(goalId)) {
      throw new Error(`The goal's agents are still stopping; ${verb} again in a moment`);
    }
  }

  /**
   * A person accepts a failed goal as is: it completes with its unverified criteria waived. The
   * reducer checks that all its work is done and merged and that every unverified criterion is
   * named. The failure already stopped the goal's agents and timers; nothing is merged or moved,
   * and the integration branch stays as it is.
   */
  async accept(goalId: string, input: AcceptGoalInput, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.accepted", "", eventId)) {
      return this.requireGoal(goalId);
    }
    refuseAgent(input.agentId, "accept a goal as is");
    const goal = this.requireManaged(goalId, "accept");
    if (goal.status !== "failed") {
      throw new Error(`Goal ${goalId} is ${goal.status}; only a failed goal can be accepted as is`);
    }
    refuseWhileRecovering(goal);
    this.requireSettled(goalId, "accept");
    return this.dispatch(goalId, eventId, {
      type: "goal.accepted",
      criterionIds: input.criterionIds,
      note: input.note.trim(),
      // The failure the goal stopped with, as the person saw it grouped; a recovery that ended
      // for a person rewrote `failureReason`.
      acceptedFrom: originalFailureReason(goal) ?? "",
      client: input.client?.trim() || "unknown",
    });
  }

  /**
   * A person dismisses an ended goal, so it stops asking for attention. It changes
   * nothing else: a failed goal can still be retried, and a reopened goal that ends
   * again needs a new acknowledgement. Acknowledging twice returns the goal unchanged.
   */
  async acknowledge(goalId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.acknowledged", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireGoal(goalId);
    if (goal.status !== "completed" && goal.status !== "failed" && goal.status !== "cancelled") {
      throw new Error(`Goal ${goalId} is ${goal.status}; only an ended goal can be acknowledged`);
    }
    if (goal.acknowledgedAt) return goal;
    return this.dispatch(goalId, eventId, { type: "goal.acknowledged" });
  }

  private async dispatch(
    goalId: string,
    eventId: string | undefined,
    body: Record<string, unknown> & { type: GoalEventInput["type"] },
  ): Promise<Goal> {
    this.requireGoal(goalId);
    // `target` scopes the client id to what the request acts on; it is not part of the event.
    const { target, ...fields } = body;
    const scope = String(target ?? body.changeSetId ?? "");
    const { goal } = await this.store.dispatch(goalId, {
      // Client ids are namespaced so they cannot collide with the Manager's own.
      id: eventId ? clientEventId(body.type, scope, eventId) : randomUUID(),
      goalId,
      ...fields,
    } as GoalEventInput);
    return goal;
  }

  /**
   * A resend with the same eventId must return the result of the first request, even
   * though the state that request changed no longer passes the usual checks.
   */
  private async alreadyApplied(
    goalId: string,
    type: string,
    changeSetId: string,
    eventId: string | undefined,
  ): Promise<boolean> {
    if (!eventId) return false;
    this.requireGoal(goalId);
    return this.log.hasEvent(goalId, clientEventId(type, changeSetId, eventId));
  }

  /** A live goal must be stopped (goal.cancel) before it is archived or deleted. */
  private requireEnded(goalId: string, action: string): Goal {
    const goal = this.requireGoal(goalId);
    if (!isTerminalGoalStatus(goal.status)) {
      throw new Error(`Goal ${goalId} is ${goal.status}; stop it before it can be ${action}`);
    }
    return goal;
  }

  /** A manual goal runs nothing, so it has nothing to pause, resume or retry. */
  private requireManaged(goalId: string, action: string): Goal {
    const goal = this.requireGoal(goalId);
    if (!goal.config) {
      throw new Error(`Goal ${goalId} is manual and runs nothing; there is nothing to ${action}`);
    }
    return goal;
  }

  private requireGoal(goalId: string): Goal {
    const goal = this.store.get(goalId);
    if (!goal) {
      throw new GoalNotFoundError(goalId);
    }
    return goal;
  }
}

/** The config with `changes` applied: absent keeps a setting, null clears an optional one. */
export function mergeConfigChanges(config: GoalConfig, changes: GoalConfigChanges): GoalConfig {
  const { limits: limitChanges, ...topLevel } = changes;
  const next: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(topLevel)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (limitChanges) {
    const limits: Record<string, unknown> = { ...config.limits };
    for (const [key, value] of Object.entries(limitChanges)) {
      if (value === undefined) continue;
      if (value === null) delete limits[key];
      else limits[key] = value;
    }
    if (Object.keys(limits).length > 0) next.limits = limits;
    else delete next.limits;
  }
  return next as GoalConfig;
}

/** JSON with object keys sorted, so two configs compare by content alone. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

/**
 * Who proposes: a person when no agent id is given, the Lead when it is the goal's Lead. The
 * id is the caller's own claim, so it can only lower what it may do: a person's revision
 * applies at once, the Lead's may wait for approval.
 */
function revisionSource(goal: Goal, agentId: string | undefined): PlanRevisionSource {
  if (agentId === undefined) return "person";
  if (goal.leadAgentId && agentId === goal.leadAgentId) return "lead";
  throw new PlanRevisionError("Only the goal's Lead or a person can revise its plan.");
}

function revisionOps(goal: Goal, input: PlanRevisionInput): PlanRevisionOp[] {
  if (input.ops && (input.tasks || input.remove)) {
    throw new PlanRevisionError("Give ops, or tasks with remove, not both.");
  }
  if (input.ops) return input.ops;
  if (!input.tasks) {
    throw new PlanRevisionError("Give ops, or the desired plan as tasks with remove.");
  }
  return diffDesiredPlan(goal, input.tasks, input.remove ?? []);
}

/** The guidance a request changes, or undefined when it changes none. */
function guidanceChanges(input: GuidanceInput): GuidanceChanges | undefined {
  const tasks = input.tasks && Object.keys(input.tasks).length > 0 ? input.tasks : undefined;
  if (input.prompt === undefined && !tasks) return undefined;
  return {
    ...(input.prompt === undefined ? {} : { goal: input.prompt }),
    ...(tasks ? { tasks } : {}),
  };
}

/**
 * Only a person starts or steers a recovery. The agent id is the caller's own claim, so this
 * stops an agent that says who it is; one that does not is treated as the person it acts for,
 * as everywhere goals run with automation.manage.
 */
function refuseAgent(agentId: string | undefined, action: string): void {
  if (agentId === undefined) return;
  throw new Error(
    `Only a person can ${action}; the request came from agent ${agentId}. Ask the person to run it.`,
  );
}

/** A retry, a second recovery or a delete would race a recovery still open. */
function refuseWhileRecovering(goal: Goal): void {
  const live = liveRecovery(goal);
  if (!live) return;
  const state = live.status === "awaiting_approval" ? "waiting for approval" : live.status;
  throw new Error(
    `Recovery ${live.id} of goal ${goal.id} is ${state}; cancel the recovery first: paseo goal recover ${goal.id} --cancel`,
  );
}

/** The goal's failed and cancelled tasks. A named task must be one of them. */
function retryableTaskIds(goal: Goal, taskId: string | undefined): string[] {
  const retryable = goal.tasks
    .filter((t) => t.status === "failed" || t.status === "cancelled")
    .map((t) => t.id);
  if (taskId && !retryable.includes(taskId)) {
    const task = goal.tasks.find((t) => t.id === taskId);
    throw new Error(
      task
        ? `Task ${taskId} is ${task.status}; only a failed or cancelled task can be retried`
        : `Task ${taskId} not found in goal ${goal.id}`,
    );
  }
  return retryable;
}
