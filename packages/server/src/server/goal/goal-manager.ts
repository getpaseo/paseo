import { stat } from "node:fs/promises";
import type pino from "pino";
import {
  GOAL_DAEMON_BOUNDS,
  goalPermissionPolicy,
  type GoalPermissionPolicy,
} from "@getpaseo/protocol/goal/config-bounds";
import type { GoalRetainedResource } from "@getpaseo/protocol/goal/rpc-schemas";
import type {
  Goal,
  GoalEvent,
  GoalEventInput,
  LeadIntervention,
  NotificationTarget,
  Task,
  TaskSpec,
  TurnUsage,
  UsageRole,
  WaitOutcome,
} from "@getpaseo/protocol/goal/types";
import { goalRoleThinking } from "@getpaseo/protocol/goal/thinking";
import {
  CAPTURE_FAILED_PREFIX,
  LEGACY_PERMISSION_FAILURE,
  NO_ANSWER_PREFIX,
  PENDING_PERMISSION_PREFIX,
  PENDING_QUESTION_PREFIX,
  RESUME_FAILED_PREFIX,
  RUN_CANCELED_TEXT,
  TIME_LIMIT_REACHED_PREFIX,
  WORKER_BLOCKED_PREFIX,
  isNoAnswerFailure,
  isPendingRequestFailure,
  isWorkerBlocked,
  needsPerson,
  personDecides,
  withoutWorkerStatus,
  workerBlockedFailureText,
  workerStatus,
} from "@getpaseo/protocol/goal/failure-wording";
import {
  absoluteDeadlineMs,
  budgetExceeded,
  excludedWaitMs,
  goalDeadlineMs,
  resolveLimits,
  systemClock,
  taskRunTimeoutMs,
  timeLimitEndMs,
  type Clock,
} from "./goal-limits.js";
import {
  GoalTransitionError,
  MAX_NOTIFICATION_ATTEMPTS,
  NOTIFICATION_BACKOFF_MS,
  checkInCapError,
  countedFailures,
  isTerminalGoalStatus,
  liveRecovery,
} from "./goal-reducer.js";
import {
  GoalRecoveries,
  integrationProblem,
  recoveryHandler,
  reworkWorktreeProblem,
} from "./goal-recovery.js";
import type { GoalStore } from "./goal-store.js";
import { ChangeSetPipeline } from "./change-set-pipeline.js";
import type { GitPort } from "./git-ops.js";
import {
  PlanParseError,
  extractPlan,
  type CheckInDecision,
  type FailureDecision,
} from "./plan-extract.js";
import { GoalThinkingError, thinkingInput, type GoalModelCatalog } from "./goal-thinking.js";
import {
  LEAD_STOP_PREFIX,
  LeadInterventions,
  TURN_TIMEOUT_PREFIX,
  dueWakeUp,
  failureWakeUpHandler,
  type WakeUp,
  wakeUpsUnblocked,
  type InterventionHandler,
} from "./lead-intervention.js";
import { CHECK_IN_TRIGGER, interventionClass } from "@getpaseo/protocol/goal/interventions";
import {
  isInterventionLive,
  pendingRevision,
  revisionNeedsApproval,
  revisionTargets,
} from "./plan-revision.js";
import { PlanValidator } from "./plan-validator.js";
import {
  MAX_ACTIVITY_DIGEST_CHARS,
  RunWatcher,
  WATCH_POLL_MS,
  checkInHandler,
  nearBudget,
  type CheckInContext,
  type RunVerdict,
  type TimelineCursor,
} from "./run-watcher.js";
import { buildReworkPrompt } from "./review.js";
import {
  buildLeadNotification,
  buildLeadPlanningPrompt,
  buildPlanCorrectionPrompt,
  buildTaskPrompt,
  truncateSummary,
} from "./prompts.js";
import { sortGoalsByPriority } from "./goal-priority.js";
import { blockedTasks, readyTasks } from "./task-graph.js";

export type TurnResult = (
  | { outcome: "completed"; text: string }
  | { outcome: "failed"; error: string }
  | { outcome: "canceled" }
  | { outcome: "needs_permission"; request?: PendingTurnRequest }
) & {
  /** What the provider reported for the turn; absent when it reported nothing. */
  usage?: TurnUsage;
};

/** What a turn that ended on `needs_permission` was waiting for. */
export interface PendingTurnRequest {
  /** `question` when the agent asked the person something; `permission` for anything it wants approved. */
  kind: "permission" | "question";
  /** The tool or request name the provider gave. */
  tool: string;
  /** The question, or what the permission is for, as the request states it, shortened. */
  text?: string;
}

/**
 * A request starts or stops waiting for a person. `ended` is set when the wait stops because
 * the turn stopped waiting (the goal switched to `fail`, the caller gave up), not because the
 * request was answered or withdrawn.
 */
export type TurnWaitChange =
  | { waiting: true; request: PendingTurnRequest }
  | { waiting: false; ended?: boolean };

/** Whose turn a usage.recorded event describes. */
export interface TurnUsageLabel {
  role: UsageRole;
  /** A worker's run. */
  runId?: string;
  /** The change set a reviewer reviews. */
  changeSetId?: string;
  /** The agent's thinking option, when known. */
  thinking?: string;
}

export interface CreateGoalAgentInput {
  provider: string;
  cwd: string;
  workspaceId: string;
  title: string;
  labels: Record<string, string>;
  /** Thinking option id; absent leaves the model's default. */
  thinking?: string;
  /**
   * The goal's permission policy, which picks the mode the agent starts in: `fail` the
   * provider's unattended mode, `wait` its default mode, `auto` its auto mode when it
   * lists one. Absent is `fail`.
   */
  permission?: GoalPermissionPolicy;
}

/** How a turn treats a permission request: end the turn, or wait for a person. */
export type TurnPermission = "fail" | "wait";

/** What the Manager needs from Paseo's agent layer. */
export interface ManagerAgentPort {
  /** `thinking` is the agent's thinking option once created, when known. */
  createAgent(input: CreateGoalAgentInput): Promise<{ agentId: string; thinking?: string }>;
  /**
   * Sends the prompt and resolves when the agent's turn ends. When the agent asks
   * for a permission, `fail` returns `needs_permission` and `wait` keeps waiting
   * until a person has answered in Paseo.
   */
  runTurn(
    agentId: string,
    prompt: string,
    options?: {
      permission?: TurnPermission | (() => TurnPermission);
      signal?: AbortSignal;
      /** Called once the agent layer has started the turn. */
      onStarted?: () => void;
      /** Hears when a request starts and stops waiting for a person; see settleTurn. */
      onWait?: (change: TurnWaitChange) => void;
    },
  ): Promise<TurnResult>;
  cancel(agentId: string): Promise<void>;
  /**
   * Resolves once the agent has no turn running, such as one a person started in its chat,
   * so a turn can start without interrupting it. Rejects when `signal` aborts or the agent
   * cannot be loaded.
   */
  waitUntilIdle(agentId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Tell an agent something without waiting for it to answer. Resolves once the
   * agent layer has accepted the prompt; rejects with the reason it did not.
   */
  notify(agentId: string, text: string): Promise<void>;
  /**
   * Switch a running agent to the mode a new agent would start in under `permission`.
   * Resolves with the mode set, and `nextTurn` when the provider only applies it from the
   * agent's next turn; null when the provider has no mode for the policy.
   */
  setPermissionMode(
    agentId: string,
    permission: GoalPermissionPolicy,
  ): Promise<{ modeId: string; nextTurn: boolean } | null>;
  /** Whether the agent has a turn running, such as one a person started in its chat. */
  isBusy(agentId: string): Promise<boolean>;
  /** Where the agent's timeline stands; null when it cannot be read. */
  timelineCursor(agentId: string): Promise<TimelineCursor | null>;
  /** The agent's recent activity as curated text, at most `maxChars`, newest kept. */
  activityDigest(agentId: string, maxChars: number): Promise<string>;
  /**
   * Steer text into the agent's running turn, recorded in its timeline as a user message.
   * Never replaces the turn: `unavailable` when the provider cannot take it or no turn runs.
   */
  steer(agentId: string, text: string): Promise<"steered" | "unavailable">;
  /**
   * Agents not archived whose labels include every one given, with their workspace. Absent
   * when the agent layer cannot be searched; a recovery Lead orphaned by a crash between its
   * creation and its lead.attached is then left in place.
   */
  findAgents?(
    labels: Record<string, string>,
  ): Promise<{ agentId: string; workspaceId: string | null }[]>;
  /** Provider ids a plan may name. */
  knownProviders(): string[];
  /** Model catalog a plan's thinking ids are checked against; absent accepts them. */
  modelCatalog?: GoalModelCatalog;
}

export interface CreateGoalWorkspaceInput {
  cwd: string;
  /** "reference" shares the repository checkout; "worktree" cuts an isolated one. */
  isolation: "reference" | "worktree";
  title: string;
  /** Name for the new worktree's branch. */
  branchName?: string;
  /** Branch or commit a new worktree starts from; defaults to the repository's default branch. */
  baseRef?: string;
  /** Keep the branch name given: do not let Paseo's first-agent auto-namer rename it. */
  keepBranchName?: boolean;
}

export interface ManagerWorkspacePort {
  create(input: CreateGoalWorkspaceInput): Promise<{ workspaceId: string; cwd: string }>;
  archive(workspaceId: string): Promise<void>;
}

export interface GoalManagerOptions {
  store: GoalStore;
  agents: ManagerAgentPort;
  workspaces: ManagerWorkspacePort;
  git: GitPort;
  logger: pino.Logger;
  /**
   * Ceiling on simultaneous worker runs across all goals. A function is read at every
   * launch, so the daemon config can change it live; undefined means the default.
   */
  maxConcurrentRuns?: number | (() => number | undefined);
  /** Time allowed for a goal's test command. */
  testTimeoutMs?: number;
  /** Time source for timeouts and retry backoff. */
  clock?: Clock;
  /** How long a cancelled turn may take to stop before it is abandoned. */
  cancelGraceMs?: number;
}

const MAX_PLAN_ATTEMPTS = 3;

/** How often the deadline is looked at again while an agent waits for a person's answer. */
const WAITING_DEADLINE_CHECK_MS = 60_000;

/** The longest delay a Node timer accepts. */
const MAX_TIMER_MS = 2 ** 31 - 1;

type DispatchOutcome = "new" | "duplicate" | "rejected";

/** A live execution attempt in this process. */
interface LiveRun {
  goalId: string;
  agentId: string | null;
  workspaceId: string | null;
  /** False for rework, which continues in a worktree that belongs to the change set. */
  ownsWorkspace: boolean;
  /** Read and review tasks leave nothing behind, so their worktree is removed on success. */
  disposable: boolean;
  cwd?: string;
  /** Set when the goal ended while the run was being set up or running. */
  canceled: boolean;
  /** The permission policy its agent was started under. */
  policy?: GoalPermissionPolicy;
  /** The commit its worktree started from, for the work summary a Lead wake-up shows. */
  baseRef?: string;
  /** Aborted when the Lead stops the run from a check-in; `stoppedBy` holds its reason. */
  leadStop: AbortController;
  stoppedBy?: string;
  /** When the worker's turn started on the Manager's clock; its time limit counts from here. */
  turnStartedAt?: number;
  /** The worker turn's time limit. */
  timeoutMs?: number;
  /** When the Lead last tried to steer a message into the worker's turn. */
  nudgedAt?: number;
  /** Time the worker's turn spent waiting for a person, waits that ended only. */
  waitedMs?: number;
  /** When the worker's current wait for a person began, while one is open. */
  waitingSince?: number;
}

interface LiveLead {
  agentId: string | null;
  /** The Lead agent's thinking option once created, when known. */
  thinking?: string;
  canceled: boolean;
}

/**
 * The Manager. It reacts to committed Goal events and answers with new events;
 * the agents it drives do the reasoning, it only schedules, records, retries and
 * recovers. Event ids are derived from run and task ids so a repeated reaction
 * is a no-op in the log.
 *
 * Shutdown contract: after stop(), nothing is recorded about runs that were in
 * flight. They stay `running` in the log and the next start() closes them out as
 * interrupted, so a restart is never mistaken for an agent failure.
 */
export class GoalManager {
  private readonly store: GoalStore;
  private readonly agents: ManagerAgentPort;
  private readonly workspaces: ManagerWorkspacePort;
  private readonly git: GitPort;
  private readonly logger: pino.Logger;
  private readonly readMaxConcurrentRuns: () => number | undefined;
  private readonly inFlight = new Map<string, LiveRun>();
  private readonly leads = new Map<string, LiveLead>();
  /** Each goal's permission policy as of its last event, so a change to it can be told apart. */
  private readonly policies = new Map<string, GoalPermissionPolicy>();
  private readonly pipeline: ChangeSetPipeline;
  private readonly pumpQueues = new Map<string, Promise<unknown>>();
  private readonly settled = new Set<Promise<unknown>>();
  private readonly clock: Clock;
  private readonly deadlines = new Map<string, () => void>();
  /** Retries waiting out their backoff, keyed `<goal>:<task>`. A restart re-creates them. */
  private readonly retries = new Map<string, () => void>();
  /** Notifications waiting out their backoff, keyed `<goal>:<target>:<key>`. A restart re-creates them. */
  private readonly notificationRetries = new Map<string, () => void>();
  /** Notifications with an attempt in progress, so one is never sent twice at once. */
  private readonly delivering = new Set<string>();
  private readonly cancelGraceMs: number;
  private readonly planValidator: PlanValidator;
  private readonly interventions: LeadInterventions;
  private readonly failureWakeUps: InterventionHandler<FailureDecision>;
  private readonly checkIns: InterventionHandler<CheckInDecision>;
  private readonly recoveryDecisions: InterventionHandler<string>;
  private readonly recoveries: GoalRecoveries;
  /** Goals whose ended recovery's Lead is still being stopped, with how many such stops run. */
  private readonly stoppingRecoveries = new Map<string, number>();
  private readonly watcher = new RunWatcher();
  /** Each goal's poll of its running workers, while it has any. */
  private readonly watchTimers = new Map<string, () => void>();
  /** Goals with a poll in progress, so polls never overlap. */
  private readonly watching = new Set<string>();
  /** What the watcher saw for each check-in it asked for, keyed `<goal>:<intervention>`. */
  private readonly checkInContexts = new Map<string, CheckInContext & { slot: string }>();
  /**
   * Runs whose wake-up the reducer refused although dueWakeUp found it due. They go on as
   * without a wake-up, so the Manager never asks for the same refused wake-up again.
   */
  private readonly refusedWakeUps = new Set<string>();
  /** The policy each failed run's agent started under, keyed `<goal>:<run>`. */
  private readonly runPolicies = new Map<string, GoalPermissionPolicy>();
  /** Failed tasks being retried or reported after a failure, per goal. */
  private readonly continuing = new Map<string, number>();
  /** Each goal's state before its latest event, to tell when deferred wake-ups may go. */
  private readonly lastSeen = new Map<string, Goal>();
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(options: GoalManagerOptions) {
    this.store = options.store;
    this.agents = options.agents;
    this.workspaces = options.workspaces;
    this.git = options.git;
    this.logger = options.logger.child({ module: "goal-manager" });
    const cap = options.maxConcurrentRuns;
    this.readMaxConcurrentRuns = typeof cap === "function" ? cap : () => cap;
    this.clock = options.clock ?? systemClock;
    this.cancelGraceMs = options.cancelGraceMs ?? 30_000;
    this.planValidator = new PlanValidator(options.agents);
    this.pipeline = new ChangeSetPipeline({
      store: options.store,
      agents: options.agents,
      workspaces: options.workspaces,
      git: options.git,
      logger: options.logger,
      testTimeoutMs: options.testTimeoutMs,
      host: {
        dispatchOutcome: (goalId, input) => this.dispatchOutcome(goalId, input),
        dispatch: (goalId, input) => this.dispatch(goalId, input),
        track: (work) => this.track(work),
        isStopped: () => this.stopped,
        failGoal: (goalId, reason) => this.failGoal(goalId, reason),
        requestPump: (goalId) => this.track(this.pump(goalId)),
        discard: (agentId, workspaceId) => this.discard(agentId, workspaceId),
        runTurn: (goalId, agentId, prompt, usage) => this.turn(goalId, agentId, prompt, usage),
        notifyLeadFinal: (goal, text) => this.track(this.notifyLeadFinal(goal, text)),
      },
    });
    this.interventions = new LeadInterventions({
      store: options.store,
      agents: options.agents,
      clock: this.clock,
      logger: this.logger,
      isStopped: () => this.stopped,
      track: (work) => this.track(work),
      runTurn: (goalId, agentId, prompt, onStarted) =>
        this.leadTurn(goalId, agentId, prompt, onStarted),
      turnEnded: (goalId) => this.resumeLeadNotifications(goalId),
    });
    this.failureWakeUps = failureWakeUpHandler({
      goal: (goalId) => this.store.get(goalId),
      record: (goalId, input) => this.record(goalId, input),
      checkSpecs: (goal, specs) => this.planValidator.check(goal, specs),
    });
    this.checkIns = checkInHandler({
      goal: (goalId) => this.store.get(goalId),
      record: (goalId, input) => this.record(goalId, input),
      steer: (goalId, runId, agentId, text) => this.steerRun(goalId, runId, agentId, text),
      stoppable: (goalId, runId) => this.stoppable(goalId, runId),
      stopRun: (goalId, runId, reason) => this.stopRun(goalId, runId, reason),
      context: (goalId, interventionId) => this.checkInContexts.get(`${goalId}:${interventionId}`),
      now: () => this.clock.now(),
    });
    this.recoveryDecisions = recoveryHandler({
      goal: (goalId) => this.store.get(goalId),
      record: (goalId, input) => this.record(goalId, input),
      now: () => this.clock.now(),
    });
    this.recoveries = new GoalRecoveries({
      store: options.store,
      agents: options.agents,
      workspaces: options.workspaces,
      git: options.git,
      logger: this.logger,
      isStopped: () => this.stopped,
      record: (goalId, input) => this.record(goalId, input),
      discard: (agentId, workspaceId) => this.discard(agentId, workspaceId),
    });
  }

  /** Begin reacting to events, then repair and resume every live goal. */
  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribe = this.store.subscribe((goal, event) => this.onEvent(goal, event));
    for (const goal of this.store.list()) {
      if (goal.config) this.policies.set(goal.id, goalPermissionPolicy(goal.config));
      this.lastSeen.set(goal.id, goal);
    }
    // No turn of the previous process is live, so nothing still waits. The time down counts as
    // waiting: the person had no way to answer either.
    for (const goal of this.store.list()) await this.closeStaleWaits(goal.id);
    for (const goal of this.store.list()) {
      if (goal.config && !isTerminalGoalStatus(goal.status)) {
        this.armDeadline(goal);
        // One goal's trouble must not keep the daemon, and every other goal, from starting.
        await this.recover(goal.id).catch(async (error) => {
          this.logger.error({ err: error, goalId: goal.id }, "Goal recovery failed");
          await this.failGoal(goal.id, `${RESUME_FAILED_PREFIX}: ${errorMessage(error)}`);
        });
      } else if (goal.config && goal.status === "failed" && goal.recovery) {
        await this.resumeRecovery(goal.id).catch((error) => {
          this.logger.error({ err: error, goalId: goal.id }, "Could not resume a goal's recovery");
        });
      }
    }
    // Ended goals too: their outcome may still be on its way to the Lead or the chat.
    for (const goal of this.store.list()) this.resumeNotifications(goal);
    await this.finishPendingDeletions();
  }

  /** End every wait the goal has open, at boot, when no turn of this process can be waiting. */
  private async closeStaleWaits(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    const { userWaitMs } = resolveLimits(goal?.config);
    for (const [agentId, wait] of Object.entries(goal?.waits?.open ?? {})) {
      const waitedMs = this.clock.now() - Date.parse(wait.since);
      if (waitedMs > userWaitMs) {
        // Counted all the same: nobody could answer while the daemon was down.
        this.logger.warn(
          { goalId, agentId, waitedMs, userWaitMs },
          "A wait left open by the last process ran past userWaitMinutes; it all counts as waiting",
        );
      }
      const lastSeq = this.store.get(goalId)?.lastSeq ?? 0;
      await this.dispatch(goalId, {
        id: `${goalId}:wait:${agentId}:${lastSeq}:restarted`,
        goalId,
        type: "wait.ended",
        agentId,
        outcome: "turn_ended",
      });
    }
  }

  /** A deletion the previous process tombstoned but did not finish: release and remove. */
  private async finishPendingDeletions(): Promise<void> {
    for (const [goalId, goal] of this.store.pendingDeletions) {
      try {
        if (goal) await this.releaseResources(goal);
        await this.store.removeTombstone(goalId);
        this.store.pendingDeletions.delete(goalId);
      } catch (error) {
        this.logger.error({ err: error, goalId }, "Could not finish deleting a goal");
      }
    }
  }

  /**
   * Stop reacting. In-flight agent turns are not awaited and nothing more is
   * recorded for them; see the shutdown contract above.
   */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const cancel of this.deadlines.values()) cancel();
    this.deadlines.clear();
    // Retries still backing off are found again by the next start.
    for (const cancel of this.retries.values()) cancel();
    this.retries.clear();
    for (const cancel of this.notificationRetries.values()) cancel();
    this.notificationRetries.clear();
    for (const cancel of this.watchTimers.values()) cancel();
    this.watchTimers.clear();
    // Decisions still open are asked again by the next start.
    this.interventions.shutdown();
    this.pipeline.shutdown();
  }

  // ---- time -------------------------------------------------------------

  /** Fail the goal when its overall time limit passes. */
  private armDeadline(goal: Goal): void {
    if (!goal.config || this.deadlines.has(goal.id)) return;
    const now = this.clock.now();
    let remaining = goalDeadlineMs(goal, now) - now;
    if (goal.waits?.since) {
      // While an agent waits the end moves with the clock, so the time left stays the same and
      // a timer set for it would fire again and again; look less often, but never past the
      // absolute deadline, which waiting does not move. wait.ended sets the exact timer again.
      const absolute = absoluteDeadlineMs(goal);
      remaining = Math.max(remaining, WAITING_DEADLINE_CHECK_MS);
      if (absolute !== null) remaining = Math.min(remaining, absolute - now);
    }
    const cancel = this.clock.setTimeout(
      () => {
        this.deadlines.delete(goal.id);
        const current = this.store.get(goal.id);
        if (!current || isTerminalGoalStatus(current.status) || this.stopped) return;
        // Timers cannot wait longer than about 24 days; if the clock jumped, look again.
        // While an agent waits for a person the end moves later; follow it.
        if (goalDeadlineMs(current, this.clock.now()) - this.clock.now() > 0) {
          this.armDeadline(current);
          return;
        }
        this.track(this.failGoal(goal.id, describeDeadline(current, this.clock.now())));
      },
      Math.min(Math.max(0, remaining), MAX_TIMER_MS),
    );
    this.deadlines.set(goal.id, cancel);
  }

  private clearDeadline(goalId: string): void {
    this.deadlines.get(goalId)?.();
    this.deadlines.delete(goalId);
  }

  /**
   * Retry a failed task after its backoff. The task waits as `failed` with no run
   * and no slot held; a restart finds it and retries it at once.
   */
  private async scheduleRetry(
    goalId: string,
    taskId: string,
    runId: string,
    delayMs: number,
  ): Promise<void> {
    const retry = () =>
      this.dispatch(goalId, {
        id: `${runId}:task-retried`,
        goalId,
        type: "task.retried",
        taskId,
      });
    if (delayMs <= 0) {
      await retry();
      return;
    }
    const key = `${goalId}:${taskId}`;
    const cancel = this.clock.setTimeout(() => {
      this.retries.delete(key);
      if (!this.stopped) this.track(retry());
    }, delayMs);
    this.retries.set(key, cancel);
  }

  private cancelRetry(goalId: string, taskId: string): void {
    const key = `${goalId}:${taskId}`;
    this.retries.get(key)?.();
    this.retries.delete(key);
  }

  private cancelRetries(goalId: string): void {
    for (const [key, cancel] of this.retries) {
      if (!key.startsWith(`${goalId}:`)) continue;
      cancel();
      this.retries.delete(key);
    }
  }

  /**
   * One agent turn under the goal's time limit and permission policy. A turn
   * that overruns is cancelled and reported as a failure.
   */
  private async turn(
    goalId: string,
    agentId: string,
    prompt: string,
    usage: TurnUsageLabel,
    runTimeoutMs?: number,
    onStarted?: () => void,
    stop?: AbortSignal,
  ): Promise<TurnResult> {
    // Keyed by the goal's position when the turn started: one agent never starts two turns there.
    const usageEventId = `${goalId}:usage:${agentId}:${this.store.get(goalId)?.lastSeq ?? 0}`;
    const result = await this.timedTurn(
      goalId,
      agentId,
      prompt,
      usage,
      runTimeoutMs,
      onStarted,
      stop,
    );
    if (!this.stopped) {
      await this.dispatch(goalId, {
        id: usageEventId,
        goalId,
        type: "usage.recorded",
        role: usage.role,
        agentId,
        ...(usage.runId ? { runId: usage.runId } : {}),
        ...(usage.changeSetId ? { changeSetId: usage.changeSetId } : {}),
        ...(usage.thinking ? { thinking: usage.thinking } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      });
    }
    return result;
  }

  /**
   * `timeoutMs` overrides the goal's run timeout, as a task's own limit does. Aborting `stop`
   * cancels the turn as the time limit does, with the same grace before it is abandoned.
   *
   * While a request waits for a person, the time limit is paused and the request gets
   * `limits.userWaitMinutes`; past it the turn is cancelled and fails as `No answer within …`,
   * whatever it then settles as. The waits are recorded (wait.started, wait.ended) before the
   * turn returns, so they come before anything recorded about its outcome.
   */
  private async timedTurn(
    goalId: string,
    agentId: string,
    prompt: string,
    label: TurnUsageLabel,
    timeoutMs?: number,
    onStarted?: () => void,
    stop?: AbortSignal,
  ): Promise<TurnResult> {
    const runTimeoutMs = timeoutMs ?? resolveLimits(this.store.get(goalId)?.config).runTimeoutMs;
    const minutes = Math.round(runTimeoutMs / 60_000);
    const abort = new AbortController();
    let timedOut = false;
    let cancelGrace: () => void = () => {};
    let giveUp: (result: TurnResult) => void = () => {};
    // An agent that ignores a cancel must not hold its slot forever: after a grace
    // period the turn is abandoned and reported as a failure.
    const abandoned = new Promise<TurnResult>((resolve) => {
      giveUp = resolve;
    });
    let graceArmed = false;
    // The first cancel arms the grace period; a later one neither renames nor extends it.
    const cancelWithGrace = (failure: string) => {
      if (graceArmed) return;
      graceArmed = true;
      this.agents.cancel(agentId).catch((cause) => {
        this.logger.warn({ err: cause, agentId }, "Failed to cancel an agent's turn");
      });
      cancelGrace = this.clock.setTimeout(() => {
        abort.abort();
        giveUp({ outcome: "failed", error: failure });
      }, this.cancelGraceMs);
    };
    // The time limit runs only while no request waits for a person.
    let turnLeftMs = runTimeoutMs;
    let turnTimerSince = this.clock.now();
    const armTurnTimer = () =>
      this.clock.setTimeout(
        () => {
          timedOut = true;
          cancelWithGrace(`${TURN_TIMEOUT_PREFIX} ${minutes} minutes and the agent did not stop`);
        },
        Math.max(0, turnLeftMs),
      );
    let cancelTimer = armTurnTimer();
    const waits = this.turnWaits(goalId, agentId, label);
    let expired: string | null = null;
    let cancelUserWait: () => void = () => {};
    const onWait = (change: TurnWaitChange) => {
      // A request seen after the time limit fired is part of a timeout, and nothing waits
      // after the allowance ran out.
      if (timedOut || expired !== null) return;
      if (change.waiting) {
        if (waits.isOpen()) return;
        cancelTimer();
        turnLeftMs -= this.clock.now() - turnTimerSince;
        waits.start(change.request);
        const request = change.request;
        // Read per wait, so a limit changed while the turn runs applies to its next request.
        const { userWaitMs } = resolveLimits(this.store.get(goalId)?.config);
        cancelUserWait = this.clock.setTimeout(() => {
          // A stop already under way keeps its own reason. An answer that lands between the last
          // poll and this timer is not seen: at worst a request answered in the last second of
          // its allowance still fails as no answer.
          if (graceArmed) return;
          const policy = goalPermissionPolicy(this.store.get(goalId)?.config);
          expired = `${NO_ANSWER_PREFIX} ${Math.round(userWaitMs / 60_000)} minutes: ${describePendingRequest(request, policy)}`;
          waits.end("expired");
          cancelWithGrace(expired);
        }, userWaitMs);
        return;
      }
      if (!waits.isOpen()) return;
      cancelUserWait();
      waits.end(change.ended ? "turn_ended" : "answered");
      turnTimerSince = this.clock.now();
      cancelTimer = armTurnTimer();
    };
    // A stop after the time limit fired changes nothing: the run fails as timed out.
    const onStop = () => {
      if (!timedOut && expired === null) cancelWithGrace("The agent was stopped and did not stop");
    };
    if (stop?.aborted) onStop();
    else stop?.addEventListener("abort", onStop, { once: true });
    const running = this.agents.runTurn(agentId, prompt, {
      // Under `auto` an agent may still ask; the request waits for a person as under `wait`.
      // Read on every poll: a goal switched to `fail`, or one that ended, ends a turn that is waiting.
      // A failed goal whose recovery Lead is deciding is live for that Lead's turn.
      permission: () => {
        const goal = this.store.get(goalId);
        if (!goal) return "fail";
        const deciding = goal.status === "failed" && goal.recovery?.status === "deciding";
        if (isTerminalGoalStatus(goal.status) && !deciding) return "fail";
        return goalPermissionPolicy(goal.config) === "fail" ? "fail" : "wait";
      },
      signal: abort.signal,
      onWait,
      ...(onStarted ? { onStarted } : {}),
    });
    // If the turn is abandoned, its eventual outcome is of no interest.
    running.catch(() => {});
    try {
      const result = await Promise.race([running, abandoned]);
      // A cancel clears the request, so the turn may settle as anything; nobody answered.
      if (expired !== null) {
        return {
          outcome: "failed",
          error: expired,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      }
      return timedOut && result.outcome !== "failed"
        ? { outcome: "failed", error: `${TURN_TIMEOUT_PREFIX} ${minutes} minutes` }
        : result;
    } finally {
      cancelTimer();
      cancelUserWait();
      cancelGrace();
      stop?.removeEventListener("abort", onStop);
      abort.abort();
      waits.end("turn_ended");
      await waits.recorded();
    }
  }

  /**
   * One turn's waits for a person, recorded in order: wait.started for a request that waited a
   * poll, wait.ended when it stopped. Ids are taken as each event is dispatched, after the one
   * before it landed, so two waits never share one. `recorded` resolves once all are dispatched.
   */
  private turnWaits(goalId: string, agentId: string, label: TurnUsageLabel) {
    let chain: Promise<unknown> = Promise.resolve();
    // The id wait.started was recorded under, null when it was refused; absent while no wait is open.
    let open: Promise<string | null> | undefined;
    const record = <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
      const next = chain.then(work).catch((error) => {
        this.logger.error({ err: error, goalId, agentId }, "Could not record a wait");
        return fallback;
      });
      chain = next;
      return next;
    };
    return {
      isOpen: () => open !== undefined,
      start: (request: PendingTurnRequest) => {
        this.noteRunWait(goalId, label.runId, true);
        open = record(async () => {
          const id = `${goalId}:wait:${agentId}:${this.store.get(goalId)?.lastSeq ?? 0}`;
          const recorded =
            !this.stopped &&
            (await this.dispatch(goalId, {
              id,
              goalId,
              type: "wait.started",
              agentId,
              role: label.role,
              ...(label.runId ? { runId: label.runId } : {}),
              request: {
                kind: request.kind,
                tool: request.tool,
                ...(request.text ? { text: request.text } : {}),
              },
            }));
          return recorded ? id : null;
        }, null);
      },
      end: (outcome: WaitOutcome) => {
        const started = open;
        if (!started) return;
        open = undefined;
        this.noteRunWait(goalId, label.runId, false);
        void record(async () => {
          const id = await started;
          // A goal that ended closed the wait itself.
          if (id === null || this.stopped || !this.store.get(goalId)?.waits?.open[agentId]) return;
          await this.dispatch(goalId, {
            id: `${id}:ended`,
            goalId,
            type: "wait.ended",
            agentId,
            outcome,
          });
        }, undefined);
      },
      recorded: () => chain,
    };
  }

  /** A run's time in its turn so far, leaving out time spent waiting for a person. */
  private turnElapsedMs(live: LiveRun, now: number): number {
    if (live.turnStartedAt === undefined) return 0;
    const waiting = live.waitingSince === undefined ? 0 : now - live.waitingSince;
    return now - live.turnStartedAt - (live.waitedMs ?? 0) - waiting;
  }

  /** Note on the run's live state that its agent started or stopped waiting. */
  private noteRunWait(goalId: string, runId: string | undefined, waiting: boolean): void {
    const live = runId ? this.inFlight.get(`${goalId}:${runId}`) : undefined;
    if (!live) return;
    const now = this.clock.now();
    if (waiting) {
      live.waitingSince = now;
      return;
    }
    if (live.waitingSince === undefined) return;
    live.waitedMs = (live.waitedMs ?? 0) + (now - live.waitingSince);
    live.waitingSince = undefined;
  }

  /** A deadline timer set while a wait was open fires at the old end; set it at the new one. */
  private onWaitEnded(goal: Goal, event: GoalEvent): void {
    if (event.type !== "wait.ended" || isTerminalGoalStatus(goal.status)) return;
    this.clearDeadline(goal.id);
    this.armDeadline(goal);
  }

  /** Resolves when no reaction work is outstanding, including running agent turns. For tests. */
  async idle(): Promise<void> {
    while (this.settled.size > 0) {
      await Promise.allSettled(this.settled);
    }
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch((error) => {
      this.logger.error({ err: error }, "Goal manager task failed");
    });
    this.settled.add(tracked);
    void tracked.finally(() => this.settled.delete(tracked));
  }

  private onEvent(goal: Goal, event: GoalEvent): void {
    const previous = this.lastSeen.get(goal.id);
    this.lastSeen.set(goal.id, goal);
    if (!goal.config || this.stopped) return;
    const previousPolicy = this.policies.get(goal.id);
    this.policies.set(goal.id, goalPermissionPolicy(goal.config));
    try {
      this.pipeline.onEvent(goal, event);
    } catch (error) {
      // The store swallows a listener's throw; the reactions below must still run, or an
      // approval or a pump this event needs is lost until the next restart.
      this.logger.error(
        { err: error, goalId: goal.id, type: event.type },
        "Pipeline reaction failed",
      );
    }
    this.onInterventionState(previous, goal);
    this.onRecoveryState(previous, goal);
    this.onWaitEnded(goal, event);
    switch (event.type) {
      case "goal.created":
        this.armDeadline(goal);
        this.track(this.plan(goal.id));
        break;
      case "plan.rejected":
        this.track(this.plan(goal.id));
        break;
      case "plan.proposed":
        this.autoApprovePlan(goal, event);
        break;
      case "plan.approved":
      case "task.added":
      case "task.succeeded":
      case "task.retried":
      case "task.failed":
      case "task.cancelled":
        this.track(this.pump(goal.id));
        break;
      case "goal.completed":
        this.clearDeadline(goal.id);
        this.track(this.notifyOrigin(goal, "completed"));
        break;
      case "goal.accepted":
        // The goal's work already stopped when it failed, and its Lead with it, so only the
        // chat that started it is told. The key is its own: the failure notice at this
        // `reopens` already used the goal-ended one.
        this.clearDeadline(goal.id);
        this.track(
          this.notifyOrigin(
            goal,
            `completed: accepted as is by a person (criteria waived: ${event.criterionIds.length})`,
            `goal-accepted-r${goal.reopens ?? 0}`,
          ),
        );
        break;
      case "goal.cancelled":
      case "goal.failed": {
        // Read now: by the time the work has stopped, a recovery may have given the goal a new Lead.
        const lead = { agentId: goal.leadAgentId, workspaceId: goal.leadWorkspaceId };
        this.clearDeadline(goal.id);
        this.track(
          this.notifyOrigin(
            goal,
            event.type === "goal.failed"
              ? `failed: ${goal.failureReason ?? "unknown reason"}`
              : "cancelled",
          ),
        );
        this.track(this.abortGoalWork(goal.id, lead));
        this.track(this.pipeline.abort(goal.id));
        break;
      }
      default:
        this.onControlEvent(goal, event, previousPolicy);
        break;
    }
  }

  private autoApprovePlan(goal: Goal, event: GoalEvent): void {
    if (!goal.config?.autoApprovePlan) return;
    this.track(
      this.dispatch(goal.id, {
        id: `${goal.id}:auto-approve:${event.id}`,
        goalId: goal.id,
        type: "plan.approved",
      }),
    );
  }

  /** Reactions to a person's controls and to recorded usage. */
  private onControlEvent(
    goal: Goal,
    event: GoalEvent,
    previousPolicy: GoalPermissionPolicy | undefined,
  ): void {
    if (event.type === "goal.resumed") {
      this.track(this.pump(goal.id));
    } else if (event.type === "goal.retried") {
      for (const taskId of event.taskIds) this.cancelRetry(goal.id, taskId);
      if (event.reopen) {
        this.armDeadline(goal);
        this.track(this.resumeReopened(goal.id));
      } else {
        this.track(this.pump(goal.id));
      }
    } else if (event.type === "changeset.integration_retried") {
      // Always a reopen: the change sets are approved again and recover() merges them.
      for (const taskId of event.taskIds) this.cancelRetry(goal.id, taskId);
      this.armDeadline(goal);
      this.track(this.resumeReopened(goal.id));
    } else if (event.type === "usage.recorded") {
      const overBudget = budgetExceeded(goal);
      // A failed goal takes only its recovery Lead's usage; an overrun ends that recovery.
      if (overBudget && goal.status === "failed") {
        if (liveRecovery(goal)) this.track(this.recoveries.endOverBudget(goal.id, overBudget));
      } else if (overBudget) {
        this.track(this.failGoal(goal.id, overBudget));
      }
    } else if (event.type === "goal.reopened") {
      // A goal that failed while planning: a fresh Lead plans, as when it was created.
      this.armDeadline(goal);
      this.track(this.plan(goal.id));
    } else if (event.type === "goal.config_updated") {
      this.onConfigUpdated(goal, event.id, previousPolicy);
    } else if (event.type === "intervention.requested") {
      this.decideIntervention(goal, event.interventionId);
    } else if (event.type === "intervention.resolved") {
      this.onInterventionResolved(goal, event.interventionId);
    } else if (
      event.type === "recovery.started" ||
      event.type === "recovery.decided" ||
      event.type === "recovery.resolved"
    ) {
      this.onRecoveryEvent(goal, event);
    } else {
      this.onRevisionEvent(goal, event);
    }
  }

  // ---- recovering a failed goal ---------------------------------------------

  /**
   * A recovery started gets its Lead; a decision the Manager may apply is applied; an applied one
   * reopened the goal, which resumes as after a retry. Its end is handled by onRecoveryState.
   */
  private onRecoveryEvent(goal: Goal, event: GoalEvent): void {
    if (event.type === "recovery.started") {
      this.track(this.recoveries.begin(goal.id));
    } else if (event.type === "recovery.decided" && goal.recovery?.status === "decided") {
      this.track(this.recoveries.apply(goal.id));
    } else if (event.type === "recovery.resolved" && goal.recovery?.status === "applied") {
      this.armDeadline(goal);
      this.track(this.resumeReopened(goal.id));
    }
  }

  /**
   * A recovery that ended without reopening the goal, whichever event ended it: tell the chat,
   * stop and archive its Lead (the ids read now, never a later Lead's), and clear what it armed.
   */
  private onRecoveryState(previous: Goal | undefined, goal: Goal): void {
    const before = previous?.recovery;
    const after = goal.recovery;
    if (goal.status !== "failed" || after?.status !== "ended" || before?.id !== after.id) return;
    if (!liveRecovery(previous ?? {})) return;
    this.endRecovery(goal);
  }

  private endRecovery(goal: Goal): void {
    const recovery = goal.recovery;
    if (!recovery) return;
    const lead = {
      agentId: recovery.leadAgentId ?? null,
      workspaceId: recovery.leadWorkspaceId ?? null,
    };
    this.clearDeadline(goal.id);
    this.clearWatch(goal.id);
    this.track(
      this.notifyOrigin(
        goal,
        `recovery ended: ${goal.failureReason ?? recovery.outcome ?? "unknown reason"}`,
        `recovery-${recovery.id}-ended`,
      ),
    );
    // Until its Lead is stopped and archived, a retry or a new recovery waits (hasLiveWork).
    this.stoppingRecoveries.set(goal.id, (this.stoppingRecoveries.get(goal.id) ?? 0) + 1);
    this.track(
      this.abortGoalWork(goal.id, lead).finally(() => {
        const left = (this.stoppingRecoveries.get(goal.id) ?? 1) - 1;
        if (left > 0) this.stoppingRecoveries.set(goal.id, left);
        else this.stoppingRecoveries.delete(goal.id);
      }),
    );
    this.track(this.pipeline.abort(goal.id));
  }

  /**
   * At start, a failed goal's recovery goes on from its state alone: a Lead is created (after
   * releasing one a crash orphaned) or asked, an open decision is asked again or expires, a
   * decided one is applied, and an ended one's Lead is released if it is still there. One
   * waiting for approval waits for its person.
   */
  private async resumeRecovery(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    const recovery = goal?.recovery;
    if (!goal || goal.status !== "failed" || !recovery) return;
    switch (recovery.status) {
      case "deciding":
        if (!recovery.leadAgentId) {
          await this.recoveries.releaseOrphans(goalId, recovery.id);
          this.track(this.recoveries.begin(goalId));
        } else if (!recovery.interventionId) {
          this.track(this.recoveries.begin(goalId));
        } else {
          this.decideIntervention(goal, recovery.interventionId);
        }
        break;
      case "decided":
        this.track(this.recoveries.apply(goalId));
        break;
      case "ended":
        // An applied recovery's Lead became the goal's, and went with the goal's own ending.
        if (recovery.outcome === "applied") break;
        if (await this.recoveries.hasLeftovers(goalId, recovery)) this.endRecovery(goal);
        break;
      default:
        break;
    }
  }

  /** Why the goal's integration worktree cannot take a recovery now, or null. */
  integrationProblem(goal: Goal): Promise<string | null> {
    return integrationProblem(goal, this.git);
  }

  /** Why a change set whose rework failed cannot be reworked again, or null. */
  reworkWorktreeProblem(goal: Goal): Promise<string | null> {
    return reworkWorktreeProblem(goal, this.git);
  }

  // ---- Lead interventions -------------------------------------------------

  /**
   * A decision this event ended (decided, superseded, abandoned) stops its loop and the
   * Manager's turn. Failure wake-ups it let go are asked first, before anything the event
   * schedules, decided against this very state.
   */
  private onInterventionState(previous: Goal | undefined, goal: Goal): void {
    try {
      this.interventions.sync(goal);
      if (previous && wakeUpsUnblocked(previous, goal)) this.wakeNext(goal);
    } catch (error) {
      // The store swallows a listener's throw; the reactions after this must still run.
      this.logger.error({ err: error, goalId: goal.id }, "Lead intervention reaction failed");
    }
  }

  /** The handler that decides an intervention of this kind; null for one this version leaves be. */
  private handlerFor(intervention: LeadIntervention): InterventionHandler<unknown> | null {
    switch (interventionClass(intervention)) {
      case "failure":
        return this.failureWakeUps;
      case "check_in":
        return this.checkIns as InterventionHandler<unknown>;
      case "recovery":
        return this.recoveryDecisions as InterventionHandler<unknown>;
      case null:
        return null;
    }
  }

  /**
   * Ask the Lead about an open intervention, in the background, with its kind's handler or the
   * one given. Nothing here reads the goal's status: a later kind about a failed goal (recovery)
   * passes its own handler and calls this for that goal.
   */
  private decideIntervention(
    goal: Goal,
    interventionId: string,
    handler?: InterventionHandler<unknown>,
  ): void {
    const intervention = goal.interventions?.find((i) => i.id === interventionId);
    const chosen = handler ?? (intervention ? this.handlerFor(intervention) : null);
    if (!chosen || intervention?.status !== "open") return;
    this.track(this.interventions.run(goal.id, interventionId, chosen));
  }

  /** Ask again about every open intervention of the goal, whatever its status. */
  private resumeDecisions(goal: Goal): number {
    const open = (goal.interventions ?? []).filter((i) => i.status === "open");
    for (const intervention of open) this.decideIntervention(goal, intervention.id);
    return open.length;
  }

  /**
   * After the Lead's continue, or no usable answer, the failed task goes on as it would have
   * without the wake-up: retried while attempts remain. After give_up the goal fails at once,
   * so independent work does not keep running and spending.
   */
  private onInterventionResolved(goal: Goal, interventionId: string): void {
    const intervention = goal.interventions?.find((i) => i.id === interventionId);
    if (intervention && interventionClass(intervention) === "failure") {
      const gaveUp = gaveUpReason(goal);
      if (gaveUp) {
        this.track(this.failGoal(goal.id, gaveUp));
        return;
      }
      this.continueAfterDecision(goal, intervention);
    }
    this.track(this.pump(goal.id));
  }

  private continueAfterDecision(goal: Goal, intervention: LeadIntervention): void {
    const goesOn =
      intervention.outcome === "continue" ||
      intervention.outcome === "expired" ||
      intervention.outcome === "lead_unavailable" ||
      intervention.outcome === "revision_rejected";
    if (!goesOn || !intervention.taskId || !intervention.runId) return;
    // Only the Lead's continue retries a blocked worker; without its answer a person decides.
    this.track(
      this.continueAfterFailure(
        goal.id,
        intervention.taskId,
        intervention.runId,
        intervention.error,
        intervention.outcome !== "continue" && personDecides(intervention.error, false),
      ),
    );
  }

  /** The Lead turn of an intervention, with its usage recorded as the Lead's. */
  private leadTurn(
    goalId: string,
    agentId: string,
    prompt: string,
    onStarted: () => void,
  ): Promise<TurnResult> {
    const config = this.store.get(goalId)?.config;
    const thinking = config ? goalRoleThinking(config, "lead") : undefined;
    const usage = { role: "lead" as const, ...(thinking ? { thinking } : {}) };
    return this.turn(goalId, agentId, prompt, usage, undefined, onStarted);
  }

  /** Records an event; the reducer's refusal comes back as its message. */
  private async record(goalId: string, input: GoalEventInput): Promise<string | null> {
    try {
      await this.store.dispatch(goalId, input);
      return null;
    } catch (error) {
      if (error instanceof GoalTransitionError) {
        this.logger.debug({ goalId, type: input.type, reason: error.message }, "Event refused");
        return error.message;
      }
      throw error;
    }
  }

  /**
   * Request the first failure wake-up that is due, and let failed tasks whose wake-up no
   * longer applies go on as without one. Decided synchronously against `goal`, so it can run
   * inside the store listener. Returns true when a wake-up was requested or is still due.
   */
  private wakeNext(goal: Goal, continueOthers = true): boolean {
    // Not gated on leadInterventions: a task deferred before it was turned off goes on here.
    if (goal.status !== "executing" || !goal.config) return false;
    const policy = goalPermissionPolicy(goal.config);
    for (const task of goal.tasks) {
      if (task.status !== "failed" || task.rework) continue;
      const run = goal.runs.findLast((r) => r.taskId === task.id);
      // failRun still owns a run in flight: it reads the work summary and decides.
      if (run && this.inFlight.has(`${goal.id}:${run.id}`)) continue;
      const { error, waitsForPerson } = this.failureOf(goal, task, policy);
      const wake = this.wakeUpFor(goal, task.id, waitsForPerson);
      if (wake === "deferred") return true;
      if (wake === "woken") continue;
      if (wake === null) {
        if (continueOthers && run) {
          this.track(
            this.continueAfterFailure(
              goal.id,
              task.id,
              run.id,
              error,
              personDecides(error, waitsForPerson),
            ),
          );
        }
        continue;
      }
      this.track(this.requestWakeUp(goal.id, task, error, wake.trigger));
      return true;
    }
    return false;
  }

  /** Record a failure wake-up; if the reducer refuses it, the task goes on as without one. */
  private async requestWakeUp(
    goalId: string,
    task: Task,
    error: string,
    trigger: string,
    workSummary?: string,
  ): Promise<void> {
    const run = this.store.get(goalId)?.runs.findLast((r) => r.taskId === task.id);
    if (!run) return;
    const interventionId = `${task.id}-a${task.attempts}`;
    const refusal = await this.record(goalId, {
      id: `${goalId}:intervention:${interventionId}`,
      goalId,
      type: "intervention.requested",
      interventionId,
      taskId: task.id,
      runId: run.id,
      trigger,
      error,
      ...(workSummary === undefined ? {} : { workSummary }),
    });
    if (refusal === null || this.stopped) return;
    const goal = this.store.get(goalId);
    if (!goal) return;
    const wake = this.wakeUpFor(goal, task.id, false);
    // Another wake-up or a revision got in first: this one waits its turn.
    if (wake === "deferred" || wake === "woken") return;
    // The reducer disagrees with dueWakeUp. Asking again would be refused again, forever:
    // this run goes on as without a wake-up.
    const key = `${goalId}:${run.id}`;
    if (!this.refusedWakeUps.has(key)) {
      this.refusedWakeUps.add(key);
      this.logger.warn({ goalId, taskId: task.id, reason: refusal }, "Lead wake-up refused");
    }
    // A wake-up is due only for a run that does not wait on a request under its policy.
    await this.continueAfterFailure(goalId, task.id, run.id, error, personDecides(error, false));
  }

  /** A failed task's last error, and whether it waits for a person rather than the Lead. */
  private failureOf(
    goal: Goal,
    task: Task,
    policy: GoalPermissionPolicy,
  ): { error: string; waitsForPerson: boolean } {
    const run = goal.runs.findLast((r) => r.taskId === task.id);
    const error = lastRunError(goal, task.id) ?? task.error ?? "";
    // As in failRun: a request waits for a person only under the policy the run started with.
    const started = run ? (this.runPolicies.get(`${goal.id}:${run.id}`) ?? policy) : policy;
    return { error, waitsForPerson: isPendingRequestFailure(error) && started === policy };
  }

  /** dueWakeUp, except for a run whose wake-up the reducer refused in this process. */
  private wakeUpFor(goal: Goal, taskId: string, waitsForPerson: boolean): WakeUp {
    const run = goal.runs.findLast((r) => r.taskId === taskId);
    if (run && this.refusedWakeUps.has(`${goal.id}:${run.id}`)) return null;
    return dueWakeUp(goal, taskId, waitsForPerson);
  }

  // ---- watching running workers --------------------------------------------

  /** Poll the goal's running workers every WATCH_POLL_MS while it has any. */
  private armWatch(goalId: string): void {
    if (this.stopped || this.watchTimers.has(goalId)) return;
    const cancel = this.clock.setTimeout(() => {
      this.watchTimers.delete(goalId);
      if (this.stopped) return;
      if (this.liveRunsFor(goalId) === 0 || !this.isGoalLive(goalId)) {
        this.watcher.forgetGoal(goalId);
        return;
      }
      this.armWatch(goalId);
      this.track(this.watchRuns(goalId));
    }, WATCH_POLL_MS);
    this.watchTimers.set(goalId, cancel);
  }

  private clearWatch(goalId: string): void {
    this.watchTimers.get(goalId)?.();
    this.watchTimers.delete(goalId);
    this.watcher.forgetGoal(goalId);
    for (const key of this.checkInContexts.keys()) {
      if (key.startsWith(`${goalId}:`)) this.checkInContexts.delete(key);
    }
  }

  private forgetWatchedRun(slot: string): void {
    this.watcher.forget(slot);
    for (const [key, context] of this.checkInContexts) {
      if (context.slot === slot) this.checkInContexts.delete(key);
    }
  }

  /**
   * Why no check-in may be asked for now, or null. Failure wake-ups come first, a Lead in a
   * turn is never queued for (the check-in is skipped, not deferred), and a goal close to a
   * budget spends nothing more on watching.
   */
  private watchBlocked(goal: Goal): string | null {
    if (goal.status !== "executing" || !goal.config?.leadInterventions || !goal.leadAgentId) {
      return "off";
    }
    if (
      (goal.interventions ?? []).some(isInterventionLive) ||
      this.interventions.hasLive(goal.id)
    ) {
      return "an intervention is live";
    }
    if (pendingRevision(goal)) return "a revision is pending";
    if (nearBudget(goal)) return "usage is near a budget";
    const policy = goalPermissionPolicy(goal.config);
    for (const task of goal.tasks) {
      if (task.status !== "failed" || task.rework) continue;
      const wake = this.wakeUpFor(goal, task.id, this.failureOf(goal, task, policy).waitsForPerson);
      if (wake === "deferred" || (wake !== null && wake !== "woken")) {
        return "a failure wake-up is due";
      }
    }
    return null;
  }

  private async watchRuns(goalId: string): Promise<void> {
    if (this.watching.has(goalId)) return;
    this.watching.add(goalId);
    try {
      await this.watchRunsNow(goalId);
    } finally {
      this.watching.delete(goalId);
    }
  }

  /**
   * One poll: read every live run of the goal, then ask for at most one check-in, about the
   * first run a rule fired for. Nothing is asked while the runs are healthy.
   */
  private async watchRunsNow(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal?.config?.leadInterventions || goal.status !== "executing") return;
    const now = this.clock.now();
    const due: DueCheckIn[] = [];
    for (const [slot, live] of this.inFlight) {
      // Not judged until its turn started: the time limit counts from there.
      if (live.goalId !== goalId || !live.agentId || live.canceled) continue;
      if (live.turnStartedAt === undefined) continue;
      const runId = slot.slice(goalId.length + 1);
      const run = goal.runs.find((r) => r.id === runId);
      const task = goal.tasks.find((t) => t.id === run?.taskId);
      if (!run || run.status !== "running" || !task) continue;
      const cursor = await this.agents.timelineCursor(live.agentId).catch(() => null);
      const verdict = this.watcher.evaluate(
        slot,
        {
          startedAtMs: live.turnStartedAt,
          timeoutMs: live.timeoutMs ?? taskRunTimeoutMs(goal, task),
          cursor,
          waitedMs: now - live.turnStartedAt - this.turnElapsedMs(live, now),
          waiting: live.waitingSince !== undefined,
        },
        now,
      );
      if (verdict.triggers.length > 0 && !checkInCapError(goal, runId)) {
        due.push({ slot, live, runId, verdict, cursor });
      }
    }
    const first = due[0];
    if (!first || this.watchBlocked(goal) || !goal.leadAgentId) return;
    if (await this.agents.isBusy(goal.leadAgentId).catch(() => true)) return;
    await this.requestCheckIn(goalId, first);
  }

  /** Ask the Lead about one run: what it did lately, and what it changed so far. */
  private async requestCheckIn(goalId: string, due: DueCheckIn): Promise<void> {
    const { slot, live, runId, verdict, cursor } = due;
    const agentId = live.agentId as string;
    const activity = await this.agents
      .activityDigest(agentId, MAX_ACTIVITY_DIGEST_CHARS)
      .catch((error) => `(activity unavailable: ${errorMessage(error)})`);
    const workSummary = live.cwd
      ? await this.git
          .workSummary({
            cwd: live.cwd,
            ...(live.baseRef ? { baseCommit: live.baseRef } : {}),
            timeoutMs: 10_000,
          })
          .catch((error) => `(work summary unavailable: ${errorMessage(error)})`)
      : undefined;
    // Things move while git runs: look again before asking.
    const goal = this.store.get(goalId);
    if (this.stopped || !goal || this.watchBlocked(goal) || live.canceled) return;
    const checkIn =
      (goal.interventions ?? []).filter(
        (i) => interventionClass(i) === "check_in" && i.runId === runId,
      ).length + 1;
    const interventionId = `${runId}:check-${checkIn}`;
    const key = `${goalId}:${interventionId}`;
    // Set before the request: its listener starts the Lead's turn, which reads it.
    this.checkInContexts.set(key, {
      slot,
      triggers: verdict.triggers,
      elapsedMs: this.turnElapsedMs(live, this.clock.now()),
      quietMs: verdict.quietMs,
      ...(verdict.runningTool ? { runningTool: verdict.runningTool } : {}),
      activity,
      ...(cursor?.lastError ? { lastError: cursor.lastError } : {}),
    });
    const taskId = goal.runs.find((r) => r.id === runId)?.taskId;
    const refusal = await this.record(goalId, {
      id: `${goalId}:intervention:${interventionId}`,
      goalId,
      type: "intervention.requested",
      interventionId,
      ...(taskId ? { taskId } : {}),
      runId,
      trigger: CHECK_IN_TRIGGER,
      triggers: verdict.triggers,
      checkIn,
      error: "",
      ...(workSummary === undefined ? {} : { workSummary }),
    });
    // Refused (the run ended, a cap, another intervention got in first): skipped this poll.
    if (refusal !== null) {
      this.checkInContexts.delete(key);
      return;
    }
    this.watcher.checkedIn(slot, verdict.triggers);
  }

  /** A run's worker turn is live here and inside its time limit, so a stop is what ends it. */
  private stoppable(goalId: string, runId: string): boolean {
    const live = this.inFlight.get(`${goalId}:${runId}`);
    if (!live || live.turnStartedAt === undefined || live.timeoutMs === undefined) return false;
    return this.turnElapsedMs(live, this.clock.now()) < live.timeoutMs;
  }

  /** The Lead's nudge; the attempt is noted even when refused, since a provider may queue it. */
  private steerRun(
    goalId: string,
    runId: string,
    agentId: string,
    text: string,
  ): Promise<"steered" | "unavailable"> {
    const live = this.inFlight.get(`${goalId}:${runId}`);
    if (live) live.nudgedAt = this.clock.now();
    return this.agents.steer(agentId, text);
  }

  /** The Lead stopped a run from a check-in: cancel its worker, which then fails with the reason. */
  private stopRun(goalId: string, runId: string, reason: string): void {
    const live = this.inFlight.get(`${goalId}:${runId}`);
    if (!live || live.stoppedBy !== undefined || !this.stoppable(goalId, runId)) return;
    live.stoppedBy = reason;
    live.leadStop.abort();
  }

  /**
   * The Manager is the only one that approves a revision on its own: a person's at once, the
   * Lead's when plans auto-approve. The service only proposes, so the two never race.
   */
  private onRevisionEvent(goal: Goal, event: GoalEvent): void {
    if (event.type === "plan.revision_proposed") {
      if (!revisionNeedsApproval(goal.config, event.source)) {
        // Called synchronously, so the approval is queued before the proposer's dispatch returns.
        this.track(this.approveRevision(goal.id, event.revisionId));
      }
    } else if (event.type === "plan.revision_approved") {
      const revision = goal.planRevisions?.find((r) => r.id === event.revisionId);
      // A retry still backing off would start the old spec, or a task that is gone.
      for (const taskId of revisionTargets(revision?.ops ?? [])) this.cancelRetry(goal.id, taskId);
      this.track(this.pump(goal.id));
    } else if (event.type === "plan.revision_rejected") {
      // A rejected answer to a wake-up leaves its task failed: it goes on as after continue.
      const revision = goal.planRevisions?.find((r) => r.id === event.revisionId);
      const answered = goal.interventions?.find((i) => i.id === revision?.interventionId);
      if (answered) this.continueAfterDecision(goal, answered);
      // settleIfStuck waited for the decision; the goal may now complete or fail.
      this.track(this.pump(goal.id));
    }
  }

  /**
   * Approve a pending revision. When the reducer refuses (verification started, the run limit
   * is used up, the plan changed underneath it), the refusal is recorded as the rejection, so
   * the goal never waits on a revision nobody will decide.
   */
  private async approveRevision(goalId: string, revisionId: string): Promise<void> {
    try {
      await this.store.dispatchOrElse(
        goalId,
        {
          id: `${goalId}:revision-approve:${revisionId}`,
          goalId,
          type: "plan.revision_approved",
          revisionId,
        },
        (reason) => ({
          id: `${goalId}:revision-reject:${revisionId}`,
          goalId,
          type: "plan.revision_rejected",
          revisionId,
          reason,
        }),
      );
    } catch (error) {
      // The goal ended, or the revision was decided, while this was queued.
      if (!(error instanceof GoalTransitionError)) throw error;
      this.logger.debug({ goalId, revisionId, reason: error.message }, "Revision approval dropped");
    }
  }

  /**
   * Approve a revision that needs no approval, for a caller that found it still pending after
   * the automatic approval should have run. Throws what made that approval fail.
   */
  async approveRevisionNow(goalId: string, revisionId: string): Promise<void> {
    await this.approveRevision(goalId, revisionId);
  }

  /** Approve the pending revision when it needs no approval under the current settings. */
  private approvePendingRevision(goal: Goal): void {
    const revision = pendingRevision(goal);
    if (revision && !revisionNeedsApproval(goal.config, revision.source)) {
      this.track(this.approveRevision(goal.id, revision.id));
    }
  }

  /**
   * New settings apply from the next turn or run, since every check reads the config
   * from the store. Only what is armed ahead of time needs a nudge here, and a new
   * permission policy is carried to the agents already running.
   */
  private onConfigUpdated(
    goal: Goal,
    eventId: string,
    previousPolicy: GoalPermissionPolicy | undefined,
  ): void {
    if (isTerminalGoalStatus(goal.status)) return;
    const policy = goalPermissionPolicy(goal.config);
    if (policy !== previousPolicy) this.track(this.applyPolicy(goal, policy));
    // The time limit or deadline may have moved either way.
    this.clearDeadline(goal.id);
    this.armDeadline(goal);
    if (goal.status === "awaiting_plan_approval" && goal.config?.autoApprovePlan) {
      this.track(
        this.dispatch(goal.id, {
          id: `${goal.id}:auto-approve:${eventId}`,
          goalId: goal.id,
          type: "plan.approved",
        }),
      );
    } else if (goal.status === "executing") {
      // Turning on autoApprovePlan approves a Lead revision that waits, as it does a plan.
      this.approvePendingRevision(goal);
      // A higher maxParallel may let more tasks start.
      this.track(this.pump(goal.id));
    }
  }

  /**
   * Switch the goal's running agents (Lead, workers, reviewers, verifier) to the mode the
   * new policy starts agents in. One agent that cannot be switched does not stop the rest.
   * Reviewers stay read-only either way: that is checked on the worktree, not by mode.
   */
  private async applyPolicy(goal: Goal, policy: GoalPermissionPolicy): Promise<void> {
    const agentIds = new Set<string>();
    const leadAgentId = goal.leadAgentId ?? this.leads.get(goal.id)?.agentId;
    if (leadAgentId) agentIds.add(leadAgentId);
    for (const run of this.inFlight.values()) {
      if (run.goalId === goal.id && run.agentId && !run.canceled) agentIds.add(run.agentId);
    }
    for (const agentId of this.pipeline.liveAgentIds(goal.id)) agentIds.add(agentId);
    const switched: string[] = [];
    const nextTurn: string[] = [];
    const unchanged: string[] = [];
    await Promise.all(
      [...agentIds].map(async (agentId) => {
        try {
          const result = await this.agents.setPermissionMode(agentId, policy);
          if (!result) unchanged.push(agentId);
          else (result.nextTurn ? nextTurn : switched).push(agentId);
        } catch (error) {
          unchanged.push(agentId);
          this.logger.warn(
            { err: error, goalId: goal.id, agentId, policy },
            "Could not apply the goal's permission policy to a running agent",
          );
        }
      }),
    );
    this.logger.info(
      { goalId: goal.id, policy, switched, nextTurn, unchanged },
      "Applied the goal's permission policy to its running agents",
    );
  }

  private async dispatchOutcome(goalId: string, input: GoalEventInput): Promise<DispatchOutcome> {
    try {
      const { duplicate } = await this.store.dispatch(goalId, input);
      return duplicate ? "duplicate" : "new";
    } catch (error) {
      // The goal was cancelled or failed while this work was in flight.
      if (error instanceof GoalTransitionError) {
        this.logger.debug({ goalId, type: input.type, reason: error.message }, "Event dropped");
        return "rejected";
      }
      throw error;
    }
  }

  /** True when the event is recorded, whether now or on an earlier delivery. */
  private async dispatch(goalId: string, input: GoalEventInput): Promise<boolean> {
    return (await this.dispatchOutcome(goalId, input)) !== "rejected";
  }

  // ---- planning ---------------------------------------------------------

  private async plan(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (this.stopped || !goal?.config || goal.status !== "planning" || this.leads.has(goalId)) {
      return;
    }
    const { config } = goal;
    const lead: LiveLead = { agentId: null, canceled: false };
    this.leads.set(goalId, lead);
    try {
      // Planning again (the plan was rejected): the earlier Lead and its worktree are done.
      if (goal.leadAgentId || goal.leadWorkspaceId) {
        await this.discard(goal.leadAgentId, goal.leadWorkspaceId);
      }
      const workspace = await this.workspaces.create({
        cwd: config.cwd,
        // The Lead reads the repository in its own worktree, so no agent works in your checkout.
        isolation: "worktree",
        title: `${goal.title} (lead)`,
        ...(config.baseCommit ? { baseRef: config.baseCommit } : {}),
      });
      const { agentId, thinking } = await this.agents
        .createAgent({
          provider: config.leadProvider,
          ...thinkingInput(goalRoleThinking(config, "lead")),
          permission: goalPermissionPolicy(config),
          cwd: workspace.cwd,
          workspaceId: workspace.workspaceId,
          title: `Lead: ${goal.title}`,
          labels: { "paseo.goal-id": goalId, "paseo.goal-role": "lead" },
        })
        .catch(async (error) => {
          // Do not strand the worktree made for an agent that never started.
          await this.discard(null, workspace.workspaceId);
          throw error;
        });
      lead.agentId = agentId;
      if (thinking) lead.thinking = thinking;
      const attached =
        !lead.canceled &&
        !this.stopped &&
        (await this.dispatch(goalId, {
          id: `${goalId}:lead:${goal.lastSeq}`,
          goalId,
          type: "lead.attached",
          agentId,
          workspaceId: workspace.workspaceId,
        }));
      if (!attached) {
        if (!this.stopped) await this.discard(agentId, workspace.workspaceId);
        return;
      }
      await this.planWithLead(goal, agentId, lead);
    } catch (error) {
      if (!this.stopped && !lead.canceled) {
        await this.failGoal(goalId, `Planning failed: ${errorMessage(error)}`);
      }
    } finally {
      this.leads.delete(goalId);
    }
  }

  private async planWithLead(goal: Goal, agentId: string, lead: LiveLead): Promise<void> {
    let prompt = buildLeadPlanningPrompt(goal, { maxConcurrentRuns: this.runCap() });
    let problem = "";
    for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS; attempt += 1) {
      const result = await this.turn(goal.id, agentId, prompt, {
        role: "lead",
        ...(lead.thinking ? { thinking: lead.thinking } : {}),
      });
      if (this.stopped || lead.canceled || this.store.get(goal.id)?.status !== "planning") return;
      if (result.outcome !== "completed") {
        const policy = goalPermissionPolicy(this.store.get(goal.id)?.config);
        const detail =
          result.outcome === "needs_permission" ||
          (result.outcome === "failed" && isNoAnswerFailure(result.error))
            ? ` ${describeFailure(result, policy)}`
            : "";
        await this.failGoal(
          goal.id,
          `Lead agent did not finish planning (${result.outcome}).${detail}`,
        );
        return;
      }
      try {
        const tasks = extractPlan(
          result.text,
          this.planValidator.providersFor(goal),
          // Read now: the limit may have been changed while the Lead was planning.
          resolveLimits(this.store.get(goal.id)?.config ?? goal.config).maxTasks,
        );
        await this.planValidator.checkThinking(goal, tasks);
        await this.dispatch(goal.id, {
          id: `${goal.id}:plan-proposed:${goal.lastSeq}:${attempt}`,
          goalId: goal.id,
          type: "plan.proposed",
          tasks,
        });
        return;
      } catch (error) {
        if (!(error instanceof PlanParseError || error instanceof GoalThinkingError)) throw error;
        problem = error.message;
        prompt = buildPlanCorrectionPrompt(problem);
      }
    }
    await this.failGoal(goal.id, `Lead did not produce a valid plan: ${problem}`);
  }

  /**
   * The checks a revision's added and replaced specs need beyond the reducer's: providers and
   * thinking ids. The service runs them before it proposes. Throws PlanRevisionError.
   */
  checkPlanSpecs(goal: Goal, specs: readonly TaskSpec[]): Promise<void> {
    return this.planValidator.check(goal, specs);
  }

  // ---- execution --------------------------------------------------------

  /** The daemon-wide cap on worker runs, as configured now. */
  private runCap(): number {
    return this.readMaxConcurrentRuns() ?? GOAL_DAEMON_BOUNDS.maxConcurrentRuns.default;
  }

  /**
   * Call after the daemon-wide cap changed. A raised cap starts ready tasks at once; a
   * lowered one lets running tasks finish and starts nothing new until under it.
   */
  capacityChanged(): void {
    if (this.stopped) return;
    this.logger.info({ maxConcurrentRuns: this.runCap() }, "Worker run cap changed");
    this.pumpAllExecuting();
  }

  /**
   * Pump every executing goal, higher priority first. Each pump claims its slots
   * before its first await, so when the daemon-wide cap is full a freed slot goes
   * to the highest-priority goal with a ready task; ties go to the older goal.
   */
  private pumpAllExecuting(): void {
    const executing = this.store
      .list()
      .filter((goal) => goal.config && goal.status === "executing");
    for (const goal of sortGoalsByPriority(executing)) this.track(this.pump(goal.id));
  }

  /** Start every task that is ready and fits under the parallelism limits. */
  private pump(goalId: string): Promise<void> {
    const previous = this.pumpQueues.get(goalId) ?? Promise.resolve();
    const run = previous.then(() => this.pumpNow(goalId));
    this.pumpQueues.set(
      goalId,
      run.catch(() => undefined),
    );
    return run;
  }

  /**
   * Ready tasks whose implement dependencies are already on the integration branch. A task a
   * pending revision replaces or removes waits for the decision.
   */
  private launchable(goal: Goal): Task[] {
    const revising = revisionTargets(pendingRevision(goal)?.ops ?? []);
    // A task the Lead is deciding about waits for that decision.
    const deciding = new Set(
      (goal.interventions ?? []).filter(isInterventionLive).map((i) => i.taskId),
    );
    return readyTasks(goal.tasks).filter(
      (task) =>
        !revising.has(task.id) &&
        !deciding.has(task.id) &&
        this.pipeline.dependenciesIntegrated(goal, task),
    );
  }

  private liveRunsFor(goalId: string): number {
    let count = 0;
    for (const run of this.inFlight.values()) if (run.goalId === goalId) count += 1;
    return count;
  }

  private async pumpNow(goalId: string): Promise<void> {
    if (this.stopped) return;
    const goal = this.store.get(goalId);
    if (!goal?.config || goal.status !== "executing") return;
    // A paused goal starts nothing, and is neither completed nor failed for being stuck.
    if (goal.pausedAt) return;

    for (const task of this.launchable(goal)) {
      // Capacity is re-read on every pass: a launch claims its slot before it
      // first awaits, so concurrent pumps for other goals cannot oversubscribe.
      if (
        this.inFlight.size >= this.runCap() ||
        this.liveRunsFor(goalId) >= goal.config.maxParallel
      ) {
        break;
      }
      await this.launch(goalId, task.id);
    }

    const latest = this.store.get(goalId);
    if (latest) await this.settleIfStuck(latest);
  }

  private async launch(goalId: string, taskId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal?.config) return;
    // The pump picked its tasks before earlier launches awaited; a revision applied since may
    // have changed, removed or held this one. Read it again, synchronously up to task.started,
    // so the run starts on the spec the reducer accepts it under.
    const task = this.launchable(goal).find((t) => t.id === taskId);
    if (!task) return;
    const { maxRuns } = resolveLimits(goal.config);
    if (goal.runs.length >= maxRuns) {
      await this.failGoal(goalId, `Run limit of ${maxRuns} reached`);
      return;
    }
    const overBudget = budgetExceeded(goal);
    if (overBudget) {
      await this.failGoal(goalId, overBudget);
      return;
    }
    const runId = `${task.id}-a${task.attempts + 1}`;
    const provider = task.provider ?? goal.config.defaultProvider;
    // Claim the slot before the first await.
    const live: LiveRun = {
      goalId,
      agentId: null,
      workspaceId: null,
      ownsWorkspace: !task.rework,
      disposable: task.kind !== "implement",
      canceled: false,
      leadStop: new AbortController(),
    };
    // Run ids are only unique within a goal, so the slot key includes the goal.
    const slot = `${goalId}:${runId}`;
    this.inFlight.set(slot, live);
    try {
      const started =
        (await this.dispatch(goalId, {
          id: `${goalId}:${runId}:task-started`,
          goalId,
          type: "task.started",
          taskId: task.id,
        })) &&
        (await this.dispatch(goalId, {
          id: `${goalId}:${runId}:run-started`,
          goalId,
          type: "run.started",
          runId,
          taskId: task.id,
          provider,
        }));
      if (!started) {
        this.inFlight.delete(slot);
        return;
      }
    } catch (error) {
      this.inFlight.delete(slot);
      throw error;
    }
    this.armWatch(goalId);
    this.track(
      this.executeRun(goalId, task.id, runId, provider, live).finally(() => {
        this.inFlight.delete(slot);
        this.forgetWatchedRun(slot);
        // A freed slot may unblock this goal or any other waiting for capacity.
        this.pumpAllExecuting();
      }),
    );
  }

  private isGoalLive(goalId: string): boolean {
    return this.store.get(goalId)?.status === "executing";
  }

  private async executeRun(
    goalId: string,
    taskId: string,
    runId: string,
    provider: string,
    live: LiveRun,
  ): Promise<void> {
    try {
      const goal = this.store.get(goalId);
      const task = goal?.tasks.find((t) => t.id === taskId);
      if (!goal?.config || !task) return;
      const alive = () => !live.canceled && !this.stopped && this.isGoalLive(goalId);

      const workspace = await this.workspaceFor(goal, task);
      live.workspaceId = workspace.workspaceId;
      live.cwd = workspace.cwd;
      if (workspace.baseRef) live.baseRef = workspace.baseRef;
      if (!alive()) return await this.abandon(live, this.stopped);

      live.policy = goalPermissionPolicy(goal.config);
      const { agentId, thinking } = await this.agents.createAgent({
        provider,
        ...thinkingInput(goalRoleThinking(goal.config, "worker", task)),
        permission: live.policy,
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        title: `${goal.title}: ${task.title}`,
        labels: {
          "paseo.goal-id": goalId,
          "paseo.goal-task": taskId,
          "paseo.goal-run": runId,
        },
      });
      live.agentId = agentId;
      if (!alive()) return await this.abandon(live, this.stopped);
      const attached = await this.dispatch(goalId, {
        id: `${runId}:attached`,
        goalId,
        type: "run.attached",
        runId,
        agentId,
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        ...(thinking ? { thinking } : {}),
      });
      if (!attached || !alive()) return await this.abandon(live, this.stopped);

      live.timeoutMs = taskRunTimeoutMs(this.store.get(goalId) ?? goal, task);
      const result = await this.turn(
        goalId,
        agentId,
        this.promptFor(goal, task),
        { role: "worker", runId, ...(thinking ? { thinking } : {}) },
        live.timeoutMs,
        () => {
          live.turnStartedAt = this.clock.now();
        },
        live.leadStop.signal,
      );
      if (this.stopped) return;
      if (live.canceled || !this.isGoalLive(goalId)) return await this.abandon(live, false);

      if (result.outcome === "completed") {
        await this.settleLateNudge(live, agentId);
        await this.finishCompletedRun(goalId, task, runId, live, result.text);
        return;
      }
      const policy = goalPermissionPolicy(this.store.get(goalId)?.config);
      await this.failRun(
        goalId,
        taskId,
        runId,
        live,
        withLeadStop(live, describeFailure(result, policy)),
      );
    } catch (error) {
      if (this.stopped) return;
      await this.failRun(goalId, taskId, runId, live, withLeadStop(live, errorMessage(error)));
    }
  }

  /**
   * A worker's turn completed. A blocked status line is the worker's own claim that something
   * outside the task stopped it, and fails the run; without a status line the run is judged as
   * it always was.
   */
  private async finishCompletedRun(
    goalId: string,
    task: Task,
    runId: string,
    live: LiveRun,
    text: string,
  ): Promise<void> {
    const status = workerStatus(text);
    if (status?.status === "blocked") {
      await this.failRun(goalId, task.id, runId, live, `${WORKER_BLOCKED_PREFIX} ${status.reason}`);
      return;
    }
    // The task is settled first: a crash after this point leaves a run that
    // recovery closes as succeeded, not a finished task that gets re-run.
    await this.completeRun(goalId, task, runId, live, withoutWorkerStatus(text));
  }

  /**
   * A nudge accepted as the turn ends can start a follow-up turn (a provider may queue a steer
   * for after the turn), which would change the worktree while its work is captured. A run that
   * completes soon after a nudge has its agent cancelled first.
   */
  private async settleLateNudge(live: LiveRun, agentId: string): Promise<void> {
    if (live.nudgedAt === undefined || this.clock.now() - live.nudgedAt >= NUDGE_SETTLE_MS) return;
    await this.agents.cancel(agentId).catch((error) => {
      this.logger.warn({ err: error, agentId }, "Failed to cancel a worker after a late nudge");
    });
  }

  /** Reuse the worktree of the change a rework task fixes; otherwise make a new workspace. */
  private async workspaceFor(
    goal: Goal,
    task: Task,
  ): Promise<{ workspaceId: string; cwd: string; baseRef?: string }> {
    const changeSet = goal.changeSets.find((c) => c.id === task.rework?.changeSetId);
    if (changeSet) return { workspaceId: changeSet.workspaceId, cwd: changeSet.cwd };
    // Every task gets its own worktree, so an unattended agent never works in the
    // user's checkout. Read and review tasks get theirs too, at the latest integrated
    // commit so they see the work they are asked about. Commits are used, not the
    // branch name, which Paseo may rename.
    const created = await this.workspaces.create({
      cwd: goal.config?.cwd ?? "",
      isolation: "worktree",
      title: task.title,
      ...baseRefFor(goal),
    });
    return { ...created, ...baseRefFor(goal) };
  }

  private promptFor(goal: Goal, task: Task): string {
    const changeSet = goal.changeSets.find((c) => c.id === task.rework?.changeSetId);
    return changeSet
      ? buildReworkPrompt(goal, task, changeSet, goal.integration?.headCommit ?? null)
      : buildTaskPrompt(goal, task);
  }

  /**
   * The task is settled first, so a crash after it leaves a run recovery closes
   * as succeeded. An implement task's work is then captured as a change set
   * before dependents are allowed to start.
   */
  private async completeRun(
    goalId: string,
    task: Task,
    runId: string,
    live: LiveRun,
    text: string,
  ): Promise<void> {
    const captures = task.kind === "implement" && live.workspaceId !== null;
    if (captures) this.pipeline.beginCapture(goalId, task.id);
    try {
      await this.dispatch(goalId, {
        id: `${runId}:task-succeeded`,
        goalId,
        type: "task.succeeded",
        taskId: task.id,
        summary: truncateSummary(text),
      });
      await this.dispatch(goalId, {
        id: `${runId}:finished`,
        goalId,
        type: "run.finished",
        runId,
        outcome: "succeeded",
      });
      if (live.disposable && live.ownsWorkspace) await this.discard(null, live.workspaceId);
      if (captures && live.workspaceId) {
        const current = this.store.get(goalId)?.tasks.find((t) => t.id === task.id) ?? task;
        const cwd = await this.cwdOf(goalId, current, live);
        await this.pipeline.capture({
          goalId,
          task: current,
          runId,
          workspaceId: live.workspaceId,
          cwd,
        });
      }
    } catch (error) {
      if (!this.stopped) {
        await this.failGoal(
          goalId,
          `${CAPTURE_FAILED_PREFIX} of ${task.id}: ${errorMessage(error)}`,
        );
      }
    } finally {
      this.pipeline.endCapture(goalId, task.id);
    }
  }

  private async cwdOf(goalId: string, task: Task, live: LiveRun): Promise<string> {
    const goal = this.store.get(goalId);
    const reused = goal?.changeSets.find((c) => c.id === task.rework?.changeSetId);
    if (reused) return reused.cwd;
    if (!live.cwd) throw new Error(`No working directory recorded for run of ${task.id}`);
    return live.cwd;
  }

  /** Release what an aborted run created. A stopping daemon leaves it for recovery. */
  private async abandon(live: LiveRun, leaveForRecovery: boolean): Promise<void> {
    if (leaveForRecovery) return;
    await this.discard(live.agentId, live.ownsWorkspace ? live.workspaceId : null);
  }

  private async discard(agentId: string | null, workspaceId: string | null): Promise<void> {
    if (agentId) {
      await this.agents.cancel(agentId).catch((error) => {
        this.logger.warn({ err: error, agentId }, "Failed to cancel agent");
      });
    }
    if (workspaceId) {
      await this.workspaces.archive(workspaceId).catch((error) => {
        this.logger.warn({ err: error, workspaceId }, "Failed to archive workspace");
      });
    }
  }

  private async failRun(
    goalId: string,
    taskId: string,
    runId: string,
    live: LiveRun,
    error: string,
  ): Promise<void> {
    await this.dispatch(goalId, {
      id: `${runId}:finished`,
      goalId,
      type: "run.finished",
      runId,
      outcome: "failed",
      error,
    });
    await this.dispatch(goalId, {
      id: `${runId}:task-failed`,
      goalId,
      type: "task.failed",
      taskId,
      error,
    });
    const goal = this.store.get(goalId);
    // A retry under the policy the agent ran with asks the same thing again: wait for a
    // person. A policy changed since then gets its retry, in the new mode.
    const waitsForPerson =
      isPendingRequestFailure(error) && live.policy === goalPermissionPolicy(goal?.config);
    // A wake-up asked for later (it was deferred) reads the policy this run started under.
    if (live.policy) this.runPolicies.set(`${goalId}:${runId}`, live.policy);
    const wake = goal ? this.wakeUpFor(goal, taskId, waitsForPerson) : null;
    const task = goal?.tasks.find((t) => t.id === taskId);
    if (wake === null) {
      // A blocked worker is not retried blindly: without the Lead, a person decides.
      await this.continueAfterFailure(
        goalId,
        taskId,
        runId,
        error,
        personDecides(error, waitsForPerson),
      );
    } else if (typeof wake === "object" && task) {
      // Read before the worktree is archived below; the Lead sees what the run left.
      const workSummary = live.cwd
        ? await this.git.workSummary({
            cwd: live.cwd,
            ...(live.baseRef ? { baseCommit: live.baseRef } : {}),
          })
        : undefined;
      if (!this.stopped) await this.requestWakeUp(goalId, task, error, wake.trigger, workSummary);
    }
    // "deferred": the task stays failed and is woken about once the live decision ends.
    // "woken": the Lead was already asked about this run; its decision says what follows.
    await this.discard(live.agentId, live.ownsWorkspace ? live.workspaceId : null);
  }

  /**
   * What follows a failed run without a Lead decision: a retry after the backoff while attempts
   * remain, else a notice to the Lead. One that stopped on a request a person must answer
   * under the same policy only notifies.
   */
  private async continueAfterFailure(
    goalId: string,
    taskId: string,
    runId: string,
    error: string,
    waitsForPerson: boolean,
  ): Promise<void> {
    // Until the retry is recorded, the goal is not stuck: settleIfStuck counts this as work.
    this.continuing.set(goalId, (this.continuing.get(goalId) ?? 0) + 1);
    try {
      await this.continueAfterFailureNow(goalId, taskId, runId, error, waitsForPerson);
    } finally {
      const left = (this.continuing.get(goalId) ?? 1) - 1;
      if (left > 0) this.continuing.set(goalId, left);
      else this.continuing.delete(goalId);
      if (!this.stopped) this.track(this.pump(goalId));
    }
  }

  private async continueAfterFailureNow(
    goalId: string,
    taskId: string,
    runId: string,
    error: string,
    waitsForPerson: boolean,
  ): Promise<void> {
    const goal = this.store.get(goalId);
    const task = goal?.tasks.find((t) => t.id === taskId);
    if (!goal?.config || !task || task.status !== "failed") return;
    if (waitsForPerson) {
      await this.notifyLeadOnce(
        goal,
        `task-${task.id}-needs-person-a${task.attempts}`,
        `task ${task.id} stopped: ${error}`,
      );
      return;
    }
    // Only attempts that failed count against the limit: a restart interrupts a
    // run without the provider having failed.
    const failed = countedFailures(goal, taskId);
    if (failed < goal.config.maxAttempts) {
      // A retry already backing off is not scheduled twice.
      if (this.retries.has(`${goalId}:${taskId}`)) return;
      // Give a struggling provider a moment before trying again, longer each time.
      await this.scheduleRetry(
        goalId,
        taskId,
        runId,
        resolveLimits(goal.config).retryBackoffMs * failed,
      );
      return;
    }
    // A task retried by hand can fail for good again; that is a new notice.
    const forgiven = task.forgivenFailures ?? 0;
    await this.notifyLeadOnce(
      goal,
      `task-${task.id}-failed${forgiven > 0 ? `-after-${forgiven}` : ""}`,
      `task ${task.id} failed after ${failed} attempts: ${error}`,
    );
  }

  /** Fail a goal that can make no more progress; tell the Lead when all work is done. */
  private async settleIfStuck(goal: Goal): Promise<void> {
    if (goal.status !== "executing") return;
    // A run that is still finishing may yet retry its task.
    const retrying = [...this.retries.keys()].some((key) => key.startsWith(`${goal.id}:`));
    const finishing = this.liveRunsFor(goal.id) > 0 || retrying || this.continuing.has(goal.id);
    const active = goal.tasks.some((t) => t.status === "running");
    if (finishing || active || this.launchable(goal).length > 0) return;
    // A pending revision may add or restore work. Its approval or rejection pumps again.
    if (pendingRevision(goal)) return;
    // The Lead is deciding about a failed task; its decision pumps again.
    if ((goal.interventions ?? []).some(isInterventionLive)) return;
    // A wake-up due (one a restart left unrequested, or one just let go) is asked first.
    if (this.wakeNext(goal, false)) return;
    // A rework that failed for good leaves its change unfixable; waiting would hang the goal.
    const deadRework = goal.tasks.find((t) => t.rework && t.status === "failed");
    if (deadRework) {
      await this.pipeline.reworkFailed(goal.id, deadRework);
      return;
    }
    // Changes still being reviewed, merged or reworked may unblock more work.
    if (this.pipeline.hasOpenWork(goal)) return;

    if (goal.tasks.every((t) => t.status === "succeeded")) {
      // Completion needs every criterion verified, which only the pipeline can attest.
      this.track(this.pipeline.verifyAndComplete(goal.id));
      return;
    }
    const blocked = blockedTasks(goal.tasks);
    const failed = goal.tasks.filter((t) => t.status === "failed");
    if (failed.length > 0 || blocked.length > 0) {
      const ids = [...failed, ...blocked].map((t) => t.id).join(", ");
      // Name the request a person has to deal with; `needs_permission` is what the app looks for.
      const asking = failed
        .map((t) => ({ id: t.id, error: lastRunError(goal, t.id) }))
        .find((t) => isPendingRequestFailure(t.error) || isNoAnswerFailure(t.error));
      const request = asking
        ? `. Task ${asking.id} stopped on a request (needs_permission): ${asking.error}`
        : "";
      // A worker's blocked claim opens the reason, quoted, so the person reads it first.
      const claim = failed
        .map((t) => ({ id: t.id, error: lastRunError(goal, t.id) ?? "" }))
        .find((t) => isWorkerBlocked(t.error));
      const opening = claim ? `${workerBlockedFailureText(claim.id, claim.error)} ` : "";
      await this.failGoal(
        goal.id,
        `${opening}No task can make progress. Failed or blocked: ${ids}${request}${gaveUpText(goal, failed)}`,
      );
    }
  }

  /**
   * The goal ended: stop every agent working for it, including one still being set up. `lead` is
   * the Lead as the ending event left it, read synchronously: a recovery started meanwhile gives
   * the goal a new Lead, which this must not stop.
   */
  private async abortGoalWork(
    goalId: string,
    lead: { agentId: string | null; workspaceId: string | null },
  ): Promise<void> {
    const targets: (LiveRun | LiveLead)[] = [...this.inFlight.values()].filter(
      (r) => r.goalId === goalId,
    );
    const planning = this.leads.get(goalId);
    if (planning) targets.push(planning);
    this.cancelRetries(goalId);
    this.clearWatch(goalId);
    // Stops the decision timers and the Manager's own decision turn; the Lead is cancelled below.
    this.interventions.abortGoal(goalId);
    for (const target of targets) target.canceled = true;
    await Promise.allSettled(
      targets.filter((t) => t.agentId).map((t) => this.agents.cancel(t.agentId as string)),
    );
    // The Lead outlives planning, so stop it by name rather than only by archiving its worktree.
    if (lead.agentId && !targets.some((t) => t.agentId === lead.agentId)) {
      await this.agents.cancel(lead.agentId).catch(() => undefined);
    }
    // A finished goal's Lead worktree is no longer needed.
    if (lead.workspaceId) await this.discard(null, lead.workspaceId);
  }

  // ---- deletion ----------------------------------------------------------

  /**
   * The goal was deleted: drop its timers and remove the worktrees it created. A
   * worktree with uncommitted changes is kept, and branches are never deleted: the
   * integration branch carries the goal's result. Returns what was left in place.
   * Never throws; a resource that could not be removed is reported as retained.
   */
  async releaseResources(goal: Goal): Promise<GoalRetainedResource[]> {
    this.clearDeadline(goal.id);
    this.clearWatch(goal.id);
    this.lastSeen.delete(goal.id);
    for (const key of this.refusedWakeUps) {
      if (key.startsWith(`${goal.id}:`)) this.refusedWakeUps.delete(key);
    }
    for (const key of this.runPolicies.keys()) {
      if (key.startsWith(`${goal.id}:`)) this.runPolicies.delete(key);
    }
    this.cancelRetries(goal.id);
    for (const [key, cancel] of this.notificationRetries) {
      if (!key.startsWith(`${goal.id}:`)) continue;
      cancel();
      this.notificationRetries.delete(key);
    }
    const retained: GoalRetainedResource[] = [];
    for (const workspace of goalWorkspaces(goal)) {
      if (workspace.cwd && (await this.hasUncommittedWork(workspace.cwd))) {
        retained.push({
          kind: "worktree",
          name: workspace.cwd,
          reason: "It has uncommitted changes",
        });
        continue;
      }
      try {
        await this.workspaces.archive(workspace.workspaceId);
      } catch (error) {
        this.logger.warn({ err: error, goalId: goal.id }, "Could not remove a goal worktree");
        retained.push({
          kind: "worktree",
          name: workspace.cwd ?? workspace.workspaceId,
          reason: `It could not be removed: ${errorMessage(error)}`,
        });
      }
    }
    for (const branch of goalBranches(goal)) {
      retained.push({ kind: "branch", name: branch, reason: "Branches are never deleted" });
    }
    return retained;
  }

  /** A directory that is gone, or that git cannot read, holds nothing worth keeping here. */
  private async hasUncommittedWork(cwd: string): Promise<boolean> {
    try {
      await stat(cwd);
    } catch {
      return false;
    }
    try {
      return !(await this.git.isClean(cwd));
    } catch {
      return false;
    }
  }

  // ---- reopening ---------------------------------------------------------

  /**
   * True while anything of this goal still runs in this process. The service
   * refuses to reopen a failed goal until its stopping work has settled.
   */
  hasLiveWork(goalId: string): boolean {
    return (
      this.liveRunsFor(goalId) > 0 ||
      this.leads.has(goalId) ||
      this.interventions.hasLive(goalId) ||
      this.recoveries.hasLive(goalId) ||
      this.stoppingRecoveries.has(goalId) ||
      this.pipeline.hasLiveWork(goalId)
    );
  }

  /**
   * A failed goal was reopened. Nothing of it runs any more, so pick up its change
   * sets where the failure left them, as after a restart, then schedule.
   */
  private async resumeReopened(goalId: string): Promise<void> {
    try {
      await this.pipeline.recover(goalId);
    } catch (error) {
      if (!this.stopped) await this.failGoal(goalId, `Reopening failed: ${errorMessage(error)}`);
      return;
    }
    await this.pump(goalId);
  }

  // ---- recovery ---------------------------------------------------------

  /** Close out work the previous daemon process left half done, then resume. */
  private async recover(goalId: string): Promise<void> {
    if (!this.store.get(goalId)?.config) return;
    await this.recoverRuns(goalId);
    await this.recoverTasks(goalId);
    await this.pipeline.recover(goalId);
    await this.recoverInterventions(goalId);
    await this.resume(goalId);
  }

  /**
   * Ask the Lead again about an intervention left open (its timer counts from requestedAt, so
   * one past its time expires at once), or request a wake-up the previous process recorded
   * the failure for but not the request.
   */
  private async recoverInterventions(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal || goal.status !== "executing") return;
    // The Lead gave up just before the stop: the goal fails as it would have.
    const gaveUp = gaveUpReason(goal);
    if (gaveUp) {
      await this.failGoal(goalId, gaveUp);
      return;
    }
    if (this.resumeDecisions(goal) === 0) this.wakeNext(goal, false);
  }

  private async recoverRuns(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal) return;
    for (const run of goal.runs.filter((r) => r.status === "running")) {
      const taskDone = goal.tasks.find((t) => t.id === run.taskId)?.status === "succeeded";
      await this.dispatch(goalId, {
        id: `${run.id}:${taskDone ? "finished" : "interrupted"}`,
        goalId,
        type: "run.finished",
        runId: run.id,
        outcome: taskDone ? "succeeded" : "interrupted",
        ...(taskDone ? {} : { error: "Interrupted by daemon restart" }),
      });
      // A rework run works in the change set's own worktree, which must survive.
      const reworks = goal.tasks.find((t) => t.id === run.taskId)?.rework !== undefined;
      if (!taskDone) await this.discard(run.agentId, reworks ? null : run.workspaceId);
    }
  }

  private async recoverTasks(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    const maxAttempts = goal?.config?.maxAttempts ?? 1;
    for (const task of goal?.tasks ?? []) {
      // An interrupted run says nothing about the provider, so it is always retried.
      // A task left failed is retried only while failed attempts remain.
      const interrupted = task.status === "running";
      // One that stopped on a request, or whose worker reported it was blocked, waits for a
      // person, as it did before the restart, unless the Lead already said continue about it.
      const strandedFailure =
        task.status === "failed" &&
        goal !== undefined &&
        countedFailures(goal, task.id) < maxAttempts &&
        !(needsPerson(lastRunError(goal, task.id)) && !leadContinued(goal, task.id)) &&
        !this.awaitsLead(goal, task.id);
      if (!interrupted && !strandedFailure) continue;
      await this.dispatch(goalId, {
        id: `${goalId}:${task.id}-a${task.attempts}:recovered-${task.status}`,
        goalId,
        type: "task.retried",
        taskId: task.id,
      });
    }
  }

  /**
   * A failed task the Lead decides about, or decided to give up on, is not retried blindly:
   * its wake-up is due or deferred, its intervention is live, or the Lead gave up.
   */
  private awaitsLead(goal: Goal, taskId: string): boolean {
    const wake = this.wakeUpFor(goal, taskId, false);
    if (wake === null) return false;
    if (wake !== "woken") return true;
    const run = goal.runs.findLast((r) => r.taskId === taskId);
    const intervention = goal.interventions?.find(
      (i) => interventionClass(i) === "failure" && i.runId === run?.id,
    );
    return !intervention || isInterventionLive(intervention) || intervention.outcome === "give_up";
  }

  private async resume(goalId: string): Promise<void> {
    const current = this.store.get(goalId);
    if (!current?.config) return;
    if (current.status === "planning") {
      // A Lead from before the restart is gone with its turn; do not leave it running.
      if (current.leadAgentId || current.leadWorkspaceId) {
        await this.discard(current.leadAgentId, current.leadWorkspaceId);
      }
      this.track(this.plan(goalId));
    } else if (current.status === "awaiting_plan_approval" && current.config.autoApprovePlan) {
      await this.dispatch(goalId, {
        id: `${goalId}:auto-approve:recovered:${current.lastSeq}`,
        goalId,
        type: "plan.approved",
      });
    } else if (current.status === "executing") {
      // A revision proposed just before the restart was never decided; same ids, so a
      // decision recorded already is a duplicate.
      this.approvePendingRevision(current);
      this.track(this.pump(goalId));
    }
  }

  // ---- helpers ----------------------------------------------------------

  private async failGoal(goalId: string, reason: string): Promise<void> {
    this.logger.warn({ goalId, reason }, "Goal failed");
    await this.dispatch(goalId, {
      id: `${goalId}:failed:${this.store.get(goalId)?.lastSeq ?? 0}`,
      goalId,
      type: "goal.failed",
      reason,
    });
  }

  /**
   * Tell the chat the goal was started from how it ended, once, as the goal ends. `key` names a
   * notice other than the goal's own ending, such as a recovery's.
   */
  private async notifyOrigin(goal: Goal, outcome: string, notice?: string): Promise<void> {
    if (!goal.config?.originAgentId) return;
    // A reopened goal ends again, and that ending is a new notice.
    const key = notice ?? (goal.reopens ? `goal-ended-r${goal.reopens}` : "goal-ended");
    await this.deliver(goal.id, {
      id: `${goal.id}:notification:origin:${key}`,
      target: "origin",
      key,
      text: buildLeadNotification(goal, outcome),
    });
  }

  /** Tell the Lead the goal completed. */
  private async notifyLeadFinal(goal: Goal, text: string): Promise<void> {
    if (!goal.config?.notifyLead || !goal.leadAgentId) return;
    await this.deliver(goal.id, {
      id: `${goal.id}:notification:lead:goal-completed`,
      target: "lead",
      key: "goal-completed",
      text: buildLeadNotification(goal, text),
    });
  }

  /** Tell the Lead once per key, however many times the situation is observed. */
  private async notifyLeadOnce(goal: Goal, key: string, reason: string): Promise<void> {
    if (!goal.config?.notifyLead || !goal.leadAgentId) return;
    const latest = this.store.get(goal.id) ?? goal;
    await this.deliver(goal.id, {
      // The id lead.notified used, so a notice an older daemon already sent is not sent again.
      id: `${goal.id}:notified:${key}`,
      target: "lead",
      key,
      text: buildLeadNotification(latest, reason),
    });
  }

  // ---- notifications ----------------------------------------------------

  /**
   * Record a notification as due, then send it. The text is stored with it, so a
   * retry, even after a restart, sends exactly what was first composed.
   */
  private async deliver(
    goalId: string,
    input: { id: string; target: NotificationTarget; key: string; text: string },
  ): Promise<void> {
    if (this.stopped) return;
    const outcome = await this.dispatchOutcome(goalId, {
      id: input.id,
      goalId,
      type: "notification.queued",
      target: input.target,
      key: input.key,
      text: input.text,
    });
    if (outcome !== "new") return;
    // Sending runs on its own, so a slow agent layer never holds up the caller.
    this.track(this.attemptNotification(goalId, input.target, input.key));
  }

  /** Send the Lead's notices held during a decision turn, except ones waiting out a backoff. */
  private resumeLeadNotifications(goalId: string): void {
    if (this.stopped) return;
    for (const notification of this.store.get(goalId)?.notifications ?? []) {
      if (notification.status !== "pending" || notification.target !== "lead") continue;
      if (this.notificationRetries.has(`${goalId}:lead:${notification.key}`)) continue;
      this.track(this.attemptNotification(goalId, "lead", notification.key));
    }
  }

  /** Send every notification still pending, at once. A delivered one is never sent again. */
  private resumeNotifications(goal: Goal): void {
    for (const notification of goal.notifications ?? []) {
      if (notification.status !== "pending") continue;
      this.track(this.attemptNotification(goal.id, notification.target, notification.key));
    }
  }

  /**
   * One delivery attempt, recorded with its outcome. A failure is retried after a
   * backoff until the attempts run out; waiting holds no run slot and blocks nothing.
   */
  private async attemptNotification(
    goalId: string,
    target: NotificationTarget,
    key: string,
  ): Promise<void> {
    const slot = `${goalId}:${target}:${key}`;
    if (this.stopped || this.delivering.has(slot)) return;
    // A notice steered into the Lead's decision turn would end up in its answer. It waits,
    // with no attempt counted, until that turn ends.
    if (target === "lead" && this.interventions.turnLive(goalId)) return;
    const goal = this.store.get(goalId);
    const notification = goal?.notifications?.find((n) => n.target === target && n.key === key);
    if (!goal || notification?.status !== "pending") return;
    this.delivering.add(slot);
    try {
      const attempt = notification.attempts + 1;
      const agentId = target === "lead" ? goal.leadAgentId : goal.config?.originAgentId;
      let error: string | null = null;
      try {
        if (!agentId) throw new Error(`The goal has no ${target} agent to notify`);
        await this.agents.notify(agentId, notification.text);
      } catch (cause) {
        error = errorMessage(cause);
      }
      // A stopped Manager records nothing; the next start sends it again.
      if (this.stopped) return;
      await this.dispatch(goalId, {
        id: `${goalId}:notification:${target}:${key}:attempt-${attempt}`,
        goalId,
        type: "notification.attempted",
        target,
        key,
        attempt,
        outcome: error === null ? "delivered" : "failed",
        ...(error === null ? {} : { error }),
      });
      if (error === null) return;
      this.logger.warn({ goalId, target, key, attempt, error }, "Notification not delivered");
      if (attempt >= MAX_NOTIFICATION_ATTEMPTS) return;
      const delay = NOTIFICATION_BACKOFF_MS[attempt - 1] ?? 0;
      const cancel = this.clock.setTimeout(() => {
        this.notificationRetries.delete(slot);
        if (!this.stopped) this.track(this.attemptNotification(goalId, target, key));
      }, delay);
      this.notificationRetries.set(slot, cancel);
    } finally {
      this.delivering.delete(slot);
    }
  }
}

/** A run that completes this soon after a nudge has its agent cancelled before capture. */
const NUDGE_SETTLE_MS = 30_000;

/** A run a watcher rule fired for, waiting for its check-in. */
interface DueCheckIn {
  slot: string;
  live: LiveRun;
  runId: string;
  verdict: RunVerdict;
  cursor: TimelineCursor | null;
}

/** Why the goal fails when the Lead gave up on a failed task's latest run; null when it did not. */
function gaveUpReason(goal: Goal): string | null {
  for (const task of goal.tasks) {
    if (task.status !== "failed") continue;
    const text = gaveUpText(goal, [task]);
    if (text) return text.slice(2);
  }
  return null;
}

/** What the Lead said when it gave up on failed tasks, for the goal's failure reason. */
function gaveUpText(goal: Goal, failed: readonly Task[]): string {
  return failed
    .map((task) => {
      const run = goal.runs.findLast((r) => r.taskId === task.id);
      const gaveUp = goal.interventions?.find(
        (i) => i.runId === run?.id && i.outcome === "give_up" && interventionClass(i) === "failure",
      );
      return gaveUp ? `. Lead gave up on ${task.id}: ${gaveUp.note ?? "no reason given"}` : "";
    })
    .join("");
}

/** The diagnosis reads these back: TIME_LIMIT_REACHED_PREFIX and DEADLINE_REACHED_PATTERN. */
function describeDeadline(goal: Goal, nowMs: number): string {
  const { goalTimeoutMs } = resolveLimits(goal.config);
  if (goalDeadlineMs(goal, nowMs) < timeLimitEndMs(goal, nowMs)) {
    return `Deadline ${goal.config?.limits?.deadlineAt} reached`;
  }
  const waited = Math.round(excludedWaitMs(goal, nowMs) / 60_000);
  const note = waited > 0 ? ` (${waited} minutes waiting for answers not counted)` : "";
  return `${TIME_LIMIT_REACHED_PREFIX} ${Math.round(goalTimeoutMs / 60_000)} minutes reached${note}`;
}

interface GoalWorkspaceRef {
  workspaceId: string;
  /** Null for the Lead's worktree, whose path is not recorded. */
  cwd: string | null;
}

/** Every workspace the goal recorded creating, once each. */
function goalWorkspaces(goal: Goal): GoalWorkspaceRef[] {
  const found = new Map<string, string | null>();
  const add = (workspaceId: string | null | undefined, cwd: string | null | undefined) => {
    if (!workspaceId) return;
    if (!found.has(workspaceId) || (cwd && !found.get(workspaceId))) {
      found.set(workspaceId, cwd ?? null);
    }
  };
  add(goal.leadWorkspaceId, null);
  add(goal.integration?.workspaceId, goal.integration?.cwd);
  for (const changeSet of goal.changeSets) add(changeSet.workspaceId, changeSet.cwd);
  for (const run of goal.runs) add(run.workspaceId, run.cwd);
  return [...found].map(([workspaceId, cwd]) => ({ workspaceId, cwd }));
}

/** Branches the goal's integration and change sets were recorded on. */
function goalBranches(goal: Goal): string[] {
  const branches = new Set<string>();
  if (goal.integration?.branch) branches.add(goal.integration.branch);
  for (const changeSet of goal.changeSets) if (changeSet.branch) branches.add(changeSet.branch);
  return [...branches];
}

/** Work builds on what is integrated so far, or else on the commit the goal started from. */
function baseRefFor(goal: Goal): { baseRef: string } | Record<string, never> {
  const ref = goal.integration?.headCommit ?? goal.config?.baseCommit;
  return ref ? { baseRef: ref } : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A run the Lead stopped fails with its reason, however its turn ended; that wakes the Lead. */
function withLeadStop(live: Pick<LiveRun, "stoppedBy">, failure: string): string {
  return live.stoppedBy === undefined ? failure : `${LEAD_STOP_PREFIX} ${live.stoppedBy}`;
}

/** What the run of a goal under `policy` ended on, in words a person can act on. */
function describeFailure(result: TurnResult, policy: GoalPermissionPolicy): string {
  switch (result.outcome) {
    case "failed":
      return result.error;
    case "canceled":
      return RUN_CANCELED_TEXT;
    case "needs_permission":
      return describePendingRequest(result.request, policy);
    case "completed":
      return "";
  }
}

function describePendingRequest(
  request: PendingTurnRequest | undefined,
  policy: GoalPermissionPolicy,
): string {
  if (!request) return LEGACY_PERMISSION_FAILURE;
  const quoted = request.text ? `: "${request.text}"` : "";
  if (request.kind === "question") {
    const advice =
      policy === "fail"
        ? "Change the policy to wait or auto, or resolve what triggers the question, then retry."
        : "Retry and answer it in the agent's chat, or resolve what triggers the question.";
    return `${PENDING_QUESTION_PREFIX} and the goal's permission policy (${policy}) cannot answer it${quoted}. ${advice}`;
  }
  const advice =
    policy === "fail"
      ? "Change the policy to wait or auto, then retry."
      : "Retry and answer it in the agent's chat.";
  return `${PENDING_PERMISSION_PREFIX} to use ${request.tool}${quoted} and the goal's permission policy (${policy}) cannot grant it. ${advice}`;
}

/** The Lead answered continue about the latest run of the task, which retries even a blocked worker. */
function leadContinued(goal: Goal, taskId: string): boolean {
  const run = goal.runs.findLast((r) => r.taskId === taskId);
  return (goal.interventions ?? []).some(
    (i) => interventionClass(i) === "failure" && i.runId === run?.id && i.outcome === "continue",
  );
}

/** The error of the task's latest failed run. */
function lastRunError(goal: Goal, taskId: string): string | null {
  const runs = goal.runs.filter((r) => r.taskId === taskId && r.status === "failed");
  return runs[runs.length - 1]?.error ?? null;
}
