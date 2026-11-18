import {
  LEAD_STOP_PREFIX,
  TURN_TIMEOUT_PREFIX,
  isNoAnswerFailure,
  isWorkerBlocked,
} from "@getpaseo/protocol/goal/failure-wording";
import {
  LAST_ATTEMPT_TRIGGER,
  type FailureTrigger,
  interventionClass,
} from "@getpaseo/protocol/goal/interventions";
import type {
  Goal,
  GoalEventInput,
  LeadIntervention,
  PlanRevisionOp,
  Task,
  TaskSpec,
} from "@getpaseo/protocol/goal/types";
import type pino from "pino";
import type { Clock } from "./goal-limits.js";
import type { ManagerAgentPort, TurnResult } from "./goal-manager.js";
import { MAX_PLAN_REVISIONS, countedFailures, failureWakeUpCapError } from "./goal-reducer.js";
import type { GoalStore } from "./goal-store.js";
import {
  InterventionDecisionError,
  extractInterventionDecision,
  type FailureDecision,
  type InterventionDecision,
} from "./plan-extract.js";
import {
  PlanRevisionError,
  diffDesiredPlan,
  isInterventionLive,
  pendingRevision,
  validatePlanRevision,
} from "./plan-revision.js";
import { buildInterventionCorrectionPrompt, buildInterventionPrompt } from "./prompts.js";

/** How long the Lead has to decide about a failed task before the Manager goes on without it. */
export const LEAD_DECISION_MS = 15 * 60_000;

/** How long the Lead has to answer a check-in; no answer means ok. */
export const CHECK_IN_DECISION_MS = 5 * 60_000;

// The wording lives in the protocol, which the diagnosis reads it from too.
export { LEAD_STOP_PREFIX, TURN_TIMEOUT_PREFIX };

/**
 * What to do about a failed task:
 * - `{ trigger }`: wake the Lead now.
 * - `"deferred"`: a wake-up is due, but another intervention is live or a revision pending.
 *   Leave the task failed and ask again once that is decided.
 * - `"woken"`: the Lead was already woken about this run. Follow that intervention: wait while
 *   it is live; after its outcome, never wake again for this run.
 * - `null`: no wake-up; retry while attempts remain, as without Lead interventions.
 */
export type WakeUp = { trigger: FailureTrigger } | "deferred" | "woken" | null;

/**
 * What a failure says about the task, first match wins. The last attempt comes first: it is
 * exempt from the per-task cap, so it always gets its wake-up while the goal's cap allows; the
 * prompt still quotes a blocked worker's reason, since it quotes the run's error.
 */
export function failureTrigger(goal: Goal, task: Task, error: string): FailureTrigger | null {
  // Nobody answered in time: only a person can answer sooner or allow longer waits.
  if (isNoAnswerFailure(error)) return null;
  const failed = countedFailures(goal, task.id);
  if (goal.config && failed >= goal.config.maxAttempts) return LAST_ATTEMPT_TRIGGER;
  if (isWorkerBlocked(error)) return "worker_blocked";
  if (error.startsWith(LEAD_STOP_PREFIX)) return "lead_stopped";
  if (error.startsWith(TURN_TIMEOUT_PREFIX)) return "timeout";
  if (failed >= 2) return "repeated_failure";
  return null;
}

/**
 * Whether the failure of task `taskId` should wake the Lead, read from the goal alone: the
 * task, its latest run and that run's error. Recovery recomputes it from the log the same way.
 * `waitsForPerson` is true when the run stopped on a request a person must answer under the
 * same permission policy; that path stays the person's. A worker that reported it was blocked
 * is told apart by its error, read here, and wakes the Lead first. A request nobody answered
 * within userWaitMinutes stays the person's too, whatever the policy.
 */
export function dueWakeUp(goal: Goal, taskId: string, waitsForPerson: boolean): WakeUp {
  if (goal.status !== "executing" || !goal.config?.leadInterventions || !goal.leadAgentId) {
    return null;
  }
  const task = goal.tasks.find((t) => t.id === taskId);
  const run = goal.runs.findLast((r) => r.taskId === taskId);
  if (!task || task.rework || task.status !== "failed" || run?.status !== "failed") return null;
  if (waitsForPerson) return null;
  const interventions = goal.interventions ?? [];
  if (interventions.some((i) => interventionClass(i) === "failure" && i.runId === run.id)) {
    return "woken";
  }
  const trigger = failureTrigger(goal, task, run.error ?? task.error ?? "");
  if (!trigger || failureWakeUpCapError(goal, task.id, trigger)) return null;
  if (interventions.some(isInterventionLive) || pendingRevision(goal)) return "deferred";
  return { trigger };
}

/** A live intervention or a pending revision holds back wake-ups. */
function wakeUpsBlocked(goal: Goal): boolean {
  return (goal.interventions ?? []).some(isInterventionLive) || pendingRevision(goal) !== undefined;
}

/**
 * Whether an event that turned `prev` into `next` let deferred wake-ups go: something held
 * them before and nothing does now. Covers every way that happens, including the reducer's own
 * resolutions (a check-in ended with its run, a retry or a person's revision superseding).
 */
export function wakeUpsUnblocked(prev: Goal, next: Goal): boolean {
  return wakeUpsBlocked(prev) && !wakeUpsBlocked(next);
}

/**
 * Why the plan cannot be revised now, or null: the revision limit is used up, or verification
 * started. The reducer refuses a proposal then, so the Lead is not offered `revise`.
 */
export function revisionUnavailable(goal: Goal): string | null {
  const revisions = goal.planRevisions?.length ?? 0;
  if (revisions >= MAX_PLAN_REVISIONS) {
    return `the plan was already revised ${revisions} times; the limit is ${MAX_PLAN_REVISIONS}`;
  }
  if (goal.verifyStartedAt) return "verification has started";
  return null;
}

/**
 * The ops a `revise` decision proposes, checked as the reducer will check them. Throws
 * InterventionDecisionError with a message for the Lead's correction turn.
 */
export function interventionRevisionOps(
  goal: Goal,
  intervention: LeadIntervention,
  decision: Extract<FailureDecision, { decision: "revise" }>,
): PlanRevisionOp[] {
  const unavailable = revisionUnavailable(goal);
  if (unavailable) {
    throw new InterventionDecisionError(
      `The plan cannot be revised: ${unavailable}. Answer "continue" or "give_up".`,
    );
  }
  try {
    const ops = decision.ops ?? diffDesiredPlan(goal, decision.tasks ?? [], decision.remove ?? []);
    validatePlanRevision(goal, ops, "lead", intervention.id);
    return ops;
  } catch (error) {
    if (error instanceof PlanRevisionError) throw new InterventionDecisionError(error.message);
    throw error;
  }
}

/** Why the Manager went on without a decision from the Lead. */
export type InterventionFallback =
  | { kind: "expired" }
  | { kind: "lead_unavailable"; note: string }
  | { kind: "unusable"; note: string };

/** The decision cannot be recorded until the pending plan revision is decided; try again then. */
export class RevisionPendingError extends Error {
  constructor(revisionId: string) {
    super(`revision ${revisionId} is still pending`);
    this.name = "RevisionPendingError";
  }
}

/**
 * What one kind of intervention needs from the loop in LeadInterventions: the prompt, how to
 * read and record the Lead's answer, what to record without one, and how long to wait. The
 * loop knows nothing of tasks or goal status, so later kinds (check-ins, recovery) add a
 * handler and leave the loop alone.
 */
export interface InterventionHandler<D> {
  /** Time the Lead has, counted from the intervention's requestedAt. */
  decisionMs: number;
  /**
   * Lead turns that may fail (the Lead errored or could not be reached) before the Manager
   * gives up on it. A turn a person interrupts does not count; the time box bounds those.
   * The count starts again after a correction turn, which is a new question.
   */
  maxTurns: number;
  /** A turn a person interrupts counts against maxTurns too, so it is not asked again. */
  interruptedCounts?: boolean;
  buildPrompt(goal: Goal, intervention: LeadIntervention): string;
  /** Throws InterventionDecisionError with a message for one correction turn. */
  parse(text: string, intervention: LeadIntervention): D;
  /**
   * Records the decision. Throws InterventionDecisionError for a correction turn, or
   * RevisionPendingError to be called again once no revision is pending.
   */
  apply(goal: Goal, intervention: LeadIntervention, decision: D): Promise<void>;
  /** Records the outcome when the Lead did not decide in time or could not be used. */
  fallback(goal: Goal, intervention: LeadIntervention, reason: InterventionFallback): Promise<void>;
}

/** What LeadInterventions needs from the Manager. */
export interface LeadInterventionsHost {
  store: Pick<GoalStore, "get" | "subscribe">;
  agents: Pick<ManagerAgentPort, "waitUntilIdle" | "cancel">;
  clock: Clock;
  logger: pino.Logger;
  isStopped(): boolean;
  track(work: Promise<unknown>): void;
  /**
   * One Lead turn under the goal's limits, its usage recorded with role `lead`. `onStarted` is
   * called once the agent layer has started the turn.
   */
  runTurn(
    goalId: string,
    agentId: string,
    prompt: string,
    onStarted: () => void,
  ): Promise<TurnResult>;
  /** A Lead turn of the Manager's ended: notifications held for it may go. */
  turnEnded(goalId: string): void;
}

/** Lead turns a failure wake-up allows to fail before going on without the Lead. */
export const MAX_LEAD_TURN_TRIES = 3;

/**
 * Turns a person may interrupt before the Manager stops asking. The time box bounds them too;
 * this keeps a provider that cancels every turn at once from spinning until it runs out.
 */
const MAX_INTERRUPTED_TURNS = 10;

interface LiveIntervention {
  goalId: string;
  interventionId: string;
  /** Aborts the wait for the Lead, or for a pending revision. */
  abort: AbortController;
  cancelTimer: () => void;
  /** The Lead whose turn the Manager is starting or running; holds its notifications. */
  turnFor: string | null;
  /** The Lead running the Manager's turn, once the agent layer started it. Only this is cancelled. */
  turnAgentId: string | null;
  /** Settles a turn that is running when the decision is released, so nothing waits on it. */
  abandonTurn: (() => void) | null;
  /** Set once the loop must stop: decided, expired, superseded or the goal ended. */
  released: boolean;
}

/**
 * Runs the Lead's decision for each open intervention: waits until the Lead is idle (a
 * person's chat turn is never interrupted), asks in a Manager turn, reads the answer with one
 * correction turn, and records it, all within the handler's decision time. At expiry only the
 * Manager's own turn is cancelled. State is in memory; after a restart recover() runs the
 * loop again for interventions still open.
 */
export class LeadInterventions {
  private readonly live = new Map<string, LiveIntervention>();

  constructor(private readonly host: LeadInterventionsHost) {}

  private key(goalId: string, interventionId: string): string {
    return `${goalId}:${interventionId}`;
  }

  /** True while the Manager's own Lead turn for the goal runs. */
  turnLive(goalId: string): boolean {
    for (const state of this.live.values()) {
      if (state.goalId === goalId && state.turnFor) return true;
    }
    return false;
  }

  /** True while an intervention of the goal is being decided in this process. */
  hasLive(goalId: string): boolean {
    for (const state of this.live.values()) if (state.goalId === goalId) return true;
    return false;
  }

  /** Decide intervention `interventionId` with `handler`. A second call while it runs is a no-op. */
  async run<D>(
    goalId: string,
    interventionId: string,
    handler: InterventionHandler<D>,
  ): Promise<void> {
    const key = this.key(goalId, interventionId);
    const first = this.open(goalId, interventionId);
    if (this.live.has(key) || this.host.isStopped() || !first) return;
    const state: LiveIntervention = {
      goalId,
      interventionId,
      abort: new AbortController(),
      cancelTimer: () => {},
      turnFor: null,
      turnAgentId: null,
      abandonTurn: null,
      released: false,
    };
    this.live.set(key, state);
    try {
      const remaining = Date.parse(first.requestedAt) + handler.decisionMs - this.host.clock.now();
      if (remaining <= 0) {
        await this.fallback(state, handler, { kind: "expired" });
        return;
      }
      state.cancelTimer = this.host.clock.setTimeout(() => {
        if (state.released || this.host.isStopped()) return;
        this.host.track(this.fallback(state, handler, { kind: "expired" }));
      }, remaining);
      await this.decide(state, handler);
    } catch (error) {
      // Nothing would ever decide an intervention left open here: go on without the Lead.
      this.host.logger.error({ err: error, goalId, interventionId }, "Lead decision failed");
      const note = `the decision could not be recorded: ${errorText(error)}`;
      await this.fallback(state, handler, { kind: "lead_unavailable", note });
    } finally {
      this.release(state, false);
      this.forget(state);
    }
  }

  private open(goalId: string, interventionId: string): LeadIntervention | null {
    const intervention = this.host.store
      .get(goalId)
      ?.interventions?.find((i) => i.id === interventionId);
    return intervention?.status === "open" ? intervention : null;
  }

  private ended(state: LiveIntervention): boolean {
    return (
      state.released ||
      this.host.isStopped() ||
      this.open(state.goalId, state.interventionId) === null
    );
  }

  private async decide<D>(state: LiveIntervention, handler: InterventionHandler<D>): Promise<void> {
    const { goalId, interventionId } = state;
    const initial = this.open(goalId, interventionId);
    const goal = this.host.store.get(goalId);
    if (!initial || !goal) return;
    let prompt = handler.buildPrompt(goal, initial);
    let corrected = false;
    let tries = 0;
    let interrupted = 0;
    let lastProblem = "";
    while (!this.ended(state)) {
      if (tries >= handler.maxTurns || interrupted >= MAX_INTERRUPTED_TURNS) {
        await this.fallback(state, handler, { kind: "lead_unavailable", note: lastProblem });
        return;
      }
      const agentId = this.host.store.get(goalId)?.leadAgentId;
      if (!agentId) {
        await this.fallback(state, handler, {
          kind: "lead_unavailable",
          note: "the goal has no Lead",
        });
        return;
      }
      try {
        await this.host.agents.waitUntilIdle(agentId, state.abort.signal);
      } catch (error) {
        if (this.ended(state)) return;
        // Counted: a Lead that cannot be loaded fails at once, and would otherwise spin.
        tries += 1;
        lastProblem = `the Lead could not be reached: ${errorText(error)}`;
        continue;
      }
      if (this.ended(state)) return;
      const result = await this.leadTurn(state, agentId, prompt);
      if (this.ended(state)) return;
      if (result.outcome === "canceled" && !handler.interruptedCounts) {
        // A person's message interrupts the turn by default. Ask again once the Lead is idle.
        interrupted += 1;
        lastProblem = "the Lead's turn was interrupted every time";
        continue;
      }
      if (result.outcome !== "completed") {
        tries += 1;
        lastProblem = `the Lead's turn ended ${result.outcome}${result.outcome === "failed" ? `: ${result.error}` : ""}`;
        continue;
      }
      const intervention = this.open(goalId, interventionId);
      if (!intervention) return;
      try {
        const decision = handler.parse(result.text, intervention);
        await this.applyWhenNoRevisionPending(state, handler, intervention, decision);
        return;
      } catch (error) {
        if (!(error instanceof InterventionDecisionError)) throw error;
        if (corrected) {
          await this.fallback(state, handler, { kind: "unusable", note: error.message });
          return;
        }
        corrected = true;
        tries = 0;
        prompt = buildInterventionCorrectionPrompt(error.message);
      }
    }
  }

  /**
   * The Manager's own Lead turn; a throw (the Lead busy after all, or gone) is a failed turn.
   * Only a turn the agent layer reported started is ever cancelled, so expiry in the gap
   * between the idle check and the start cannot cancel a turn a person started. A decision
   * released while its turn runs stops waiting for it at once (an agent may ignore a cancel).
   */
  private async leadTurn(
    state: LiveIntervention,
    agentId: string,
    prompt: string,
  ): Promise<TurnResult> {
    state.turnFor = agentId;
    const abandoned = new Promise<TurnResult>((resolve) => {
      state.abandonTurn = () => resolve({ outcome: "canceled" });
    });
    const onStarted = () => {
      if (state.released) this.cancelOwnTurn(agentId);
      else state.turnAgentId = agentId;
    };
    const running = this.host.runTurn(state.goalId, agentId, prompt, onStarted);
    running.catch(() => {});
    try {
      return await Promise.race([running, abandoned]);
    } catch (error) {
      return { outcome: "failed", error: errorText(error) };
    } finally {
      state.turnFor = null;
      state.turnAgentId = null;
      state.abandonTurn = null;
      this.host.turnEnded(state.goalId);
    }
  }

  private cancelOwnTurn(agentId: string): void {
    this.host.agents.cancel(agentId).catch((error) => {
      this.host.logger.warn({ err: error, agentId }, "Failed to cancel the Lead's decision turn");
    });
  }

  /**
   * A revise answer cannot be proposed while another revision (a person's) is pending. That
   * is passing: wait for its decision and apply again against the plan as it is then.
   */
  private async applyWhenNoRevisionPending<D>(
    state: LiveIntervention,
    handler: InterventionHandler<D>,
    intervention: LeadIntervention,
    decision: D,
  ): Promise<void> {
    let current = intervention;
    for (;;) {
      const goal = this.host.store.get(state.goalId);
      if (!goal) return;
      try {
        await handler.apply(goal, current, decision);
        return;
      } catch (error) {
        if (!(error instanceof RevisionPendingError)) throw error;
      }
      try {
        await this.untilNoRevisionPending(state);
      } catch {
        return;
      }
      const reopened = this.open(state.goalId, state.interventionId);
      if (!reopened || this.ended(state)) return;
      current = reopened;
    }
  }

  private untilNoRevisionPending(state: LiveIntervention): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const signal = state.abort.signal;
      let unsubscribe: () => void = () => {};
      const finish = (error?: Error) => {
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new Error("aborted"));
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      unsubscribe = this.host.store.subscribe((goal) => {
        if (goal.id === state.goalId && !pendingRevision(goal)) finish();
      });
      const goal = this.host.store.get(state.goalId);
      if (!goal || !pendingRevision(goal)) finish();
    });
  }

  private async fallback<D>(
    state: LiveIntervention,
    handler: InterventionHandler<D>,
    reason: InterventionFallback,
  ): Promise<void> {
    if (this.host.isStopped()) return;
    const goal = this.host.store.get(state.goalId);
    const intervention = this.open(state.goalId, state.interventionId);
    if (!goal || !intervention) return;
    // Expiry stops the wait, and the Manager's own turn if it runs; never a person's turn.
    this.release(state, reason.kind === "expired");
    await handler.fallback(goal, intervention, reason);
  }

  /**
   * Stop deciding: clear the timer and the waits, and with `cancelTurn` cancel the Manager's
   * own Lead turn if one runs. Never touches a turn a person started.
   */
  private release(state: LiveIntervention, cancelTurn: boolean): void {
    // The entry stays until run() returns, so a second run() for it stays a no-op.
    state.released = true;
    state.cancelTimer();
    state.abort.abort();
    if (cancelTurn && state.turnAgentId) this.cancelOwnTurn(state.turnAgentId);
    // Waiting on a cancelled turn would hold hasLiveWork, and so retry and delete, until the
    // agent stops. Its usage is still recorded when it ends.
    if (cancelTurn) state.abandonTurn?.();
  }

  /**
   * Call with each new state of a goal. An intervention decided elsewhere (a person's retry
   * or revision superseded it, the goal ended, a revision answering it was decided) stops its
   * loop and the Manager's own turn for it.
   */
  sync(goal: Goal): void {
    for (const state of this.live.values()) {
      if (state.goalId !== goal.id || state.released) continue;
      const intervention = goal.interventions?.find((i) => i.id === state.interventionId);
      if (intervention?.status !== "open") this.release(state, true);
    }
  }

  /** The goal ended: stop every decision for it, cancelling only the Manager's own turns. */
  abortGoal(goalId: string): void {
    for (const state of this.live.values()) {
      if (state.goalId === goalId) this.release(state, true);
    }
  }

  /** The Manager stops: drop timers and waits. Nothing is recorded; recover() picks them up. */
  shutdown(): void {
    for (const state of this.live.values()) this.release(state, false);
    this.live.clear();
  }

  /** Remove a finished loop's entry. */
  private forget(state: LiveIntervention): void {
    const key = this.key(state.goalId, state.interventionId);
    if (this.live.get(key) === state) this.live.delete(key);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the failure wake-up handler needs from the Manager. */
export interface FailureWakeUpDeps {
  /** The goal as it is now. */
  goal(goalId: string): Goal | undefined;
  /** Records an event. Resolves with the reducer's refusal, or null when recorded (or already). */
  record(goalId: string, input: GoalEventInput): Promise<string | null>;
  /** Provider and thinking checks on added and replaced specs; throws PlanRevisionError. */
  checkSpecs(goal: Goal, specs: readonly TaskSpec[]): Promise<void>;
}

const FALLBACK_OUTCOMES: Record<InterventionFallback["kind"], string> = {
  expired: "expired",
  lead_unavailable: "lead_unavailable",
  // An answer that could not be used twice counts as continue, with the reason as the note.
  unusable: "continue",
};

/**
 * Failure wake-ups: the Lead answers continue, give_up or revise about a failed task. A revise
 * is proposed as the Lead's revision answering the intervention (revision id = intervention
 * id), checked as the reducer and the service check one; its approval or rejection resolves
 * the intervention.
 */
export function failureWakeUpHandler(
  deps: FailureWakeUpDeps,
): InterventionHandler<FailureDecision> {
  return {
    decisionMs: LEAD_DECISION_MS,
    maxTurns: MAX_LEAD_TURN_TRIES,
    buildPrompt: (goal, intervention) =>
      buildInterventionPrompt(goal, intervention, {
        decisionMinutes: Math.round(LEAD_DECISION_MS / 60_000),
        revisionUnavailable: revisionUnavailable(goal),
      }),
    parse(text, intervention) {
      const decision = extractInterventionDecision(text, intervention);
      if (!isFailureDecision(decision)) {
        throw new InterventionDecisionError(
          '"decision" must be one of "revise", "continue", "give_up".',
        );
      }
      return decision;
    },
    async apply(goal, intervention, decision) {
      const { id } = intervention;
      if (decision.decision !== "revise") {
        await deps.record(goal.id, {
          id: `${goal.id}:intervention:${id}:resolved`,
          goalId: goal.id,
          type: "intervention.resolved",
          interventionId: id,
          outcome: decision.decision,
          note: decision.reason,
        });
        return;
      }
      const pending = pendingRevision(goal);
      if (pending) throw new RevisionPendingError(pending.id);
      const ops = interventionRevisionOps(goal, intervention, decision);
      try {
        await deps.checkSpecs(
          goal,
          ops.flatMap((op) => (op.op === "remove" ? [] : [op.task])),
        );
      } catch (error) {
        if (error instanceof PlanRevisionError) throw new InterventionDecisionError(error.message);
        throw error;
      }
      const refusal = await deps.record(goal.id, {
        id: `${goal.id}:revision:${id}`,
        goalId: goal.id,
        type: "plan.revision_proposed",
        revisionId: id,
        source: "lead",
        reason: decision.reason,
        ops,
        interventionId: id,
      });
      if (refusal === null) return;
      // Something changed under the answer: a revision was proposed meanwhile, or the plan moved.
      const pendingNow = pendingRevision(deps.goal(goal.id) ?? goal);
      if (pendingNow) throw new RevisionPendingError(pendingNow.id);
      throw new InterventionDecisionError(refusal);
    },
    async fallback(goal, intervention, reason) {
      const outcome = FALLBACK_OUTCOMES[reason.kind];
      await deps.record(goal.id, {
        id: `${goal.id}:intervention:${intervention.id}:${reason.kind}`,
        goalId: goal.id,
        type: "intervention.resolved",
        interventionId: intervention.id,
        outcome,
        ...(reason.kind === "expired"
          ? {}
          : {
              note:
                reason.kind === "unusable"
                  ? `The Lead's answer could not be used: ${reason.note}`
                  : reason.note,
            }),
      });
    },
  };
}

function isFailureDecision(decision: InterventionDecision): decision is FailureDecision {
  return (
    decision.decision === "revise" ||
    decision.decision === "continue" ||
    decision.decision === "give_up"
  );
}
