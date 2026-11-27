import type {
  AgentRun,
  Goal,
  GoalEventInput,
  LeadIntervention,
} from "@getpaseo/protocol/goal/types";
import { resolveLimits } from "./goal-limits.js";
import {
  CHECK_IN_DECISION_MS,
  type InterventionFallback,
  type InterventionHandler,
} from "./lead-intervention.js";
import {
  InterventionDecisionError,
  extractInterventionDecision,
  type CheckInDecision,
} from "./plan-extract.js";
import { buildCheckInPrompt } from "./prompts.js";

/** How often the Manager looks at a goal's running workers. */
export const WATCH_POLL_MS = 60_000;

/** A worker whose timeline has not moved this long, with no tool running, has stalled. */
export const STALL_MS = 20 * 60_000;

/** A run past this share of its time limit nears it. */
export const NEAR_TIMEOUT_FRACTION = 0.75;

/** Check-ins are skipped once usage reaches this share of a budget. */
export const WATCH_BUDGET_FRACTION = 0.8;

/** The worker's recent activity shown to the Lead is cut to this. */
export const MAX_ACTIVITY_DIGEST_CHARS = 3000;

/** How a nudge reaches the worker: a message, not a system notification. */
export const NUDGE_PREFIX = "Message from this goal's Lead (another agent):";

export type WatchTrigger = "near_timeout" | "stall";

/** Where a worker's timeline stands, as the watcher reads it. */
export interface TimelineCursor {
  /** The sequence number of the next raw row; grows with every row, merged or not. */
  nextSeq: number;
  /** Timestamp of the last row; null for an empty timeline. */
  lastTimestamp: string | null;
  /** Tool calls still running in the latest turn, among the last rows. */
  runningTools: { callId: string; name: string }[];
  /** The text of the last error among the last rows, capped. */
  lastError?: string;
}

/** What the watcher reads about one live run at a poll. */
export interface RunObservation {
  startedAtMs: number;
  /** The run's effective time limit. */
  timeoutMs: number;
  /** Null when the timeline cannot be read; stall is then not judged. */
  cursor: TimelineCursor | null;
  /**
   * Time the run spent waiting for a person's answer, the wait still open included. It does not
   * count toward the time limit, so it is left out of the run's elapsed time.
   */
  waitedMs?: number;
  /** True while the run waits for a person's answer. */
  waiting?: boolean;
}

/** What one poll found about one run. */
export interface RunVerdict {
  triggers: WatchTrigger[];
  /** Time since the watcher last saw the timeline move. */
  quietMs: number;
  /** The longest-running tool call still running, and how long the watcher has seen it. */
  runningTool?: { name: string; ms: number };
}

interface RunWatch {
  /** When the watcher first saw each running tool call, by call id. */
  toolsSeenAt: Map<string, number>;
  seq: number | null;
  stamp: string | null;
  /** When the watcher last saw the timeline move, or first saw the run. */
  movedAt: number;
  /** Quiet time that counts as a stall; doubled after a stall check-in. */
  stallMs: number;
  /** False after a stall check-in until the timeline moves again. */
  stallArmed: boolean;
  nearTimeoutDone: boolean;
}

/**
 * Deterministic rules on live runs, so the Lead is only woken when one fires. State is per run
 * and in memory: a restart relaunches runs under new ids, which start fresh.
 */
export class RunWatcher {
  private readonly runs = new Map<string, RunWatch>();

  /**
   * Read run `key` at `now`. A run younger than one poll gives nothing. `near_timeout` fires once
   * per run; `stall` after STALL_MS without the timeline moving, never while a tool call runs
   * (one long command is not a stall). A tool row's timestamp moves with its updates, so how long
   * a tool runs is counted from when the watcher first saw it. A run waiting for a person's
   * answer gives nothing, and its quiet time counts from when the wait ended.
   */
  evaluate(key: string, obs: RunObservation, now: number): RunVerdict {
    const { cursor } = obs;
    let state = this.runs.get(key);
    if (!state) {
      state = {
        toolsSeenAt: new Map(),
        seq: cursor?.nextSeq ?? null,
        stamp: cursor?.lastTimestamp ?? null,
        movedAt: now,
        stallMs: STALL_MS,
        stallArmed: true,
        nearTimeoutDone: false,
      };
      this.runs.set(key, state);
    } else if (cursor && (cursor.nextSeq !== state.seq || cursor.lastTimestamp !== state.stamp)) {
      state.seq = cursor.nextSeq;
      state.stamp = cursor.lastTimestamp;
      state.movedAt = now;
      state.stallArmed = true;
    }
    if (obs.waiting) {
      state.movedAt = now;
      state.stallArmed = true;
    }
    const tool = oldestRunningTool(state, cursor, now);
    const verdict: RunVerdict = {
      triggers: [],
      quietMs: now - state.movedAt,
      ...(tool ? { runningTool: tool } : {}),
    };
    const elapsed = now - obs.startedAtMs - (obs.waitedMs ?? 0);
    if (obs.waiting || elapsed < WATCH_POLL_MS) return verdict;
    if (!state.nearTimeoutDone && elapsed >= NEAR_TIMEOUT_FRACTION * obs.timeoutMs) {
      verdict.triggers.push("near_timeout");
    }
    if (cursor && !tool && state.stallArmed && verdict.quietMs >= state.stallMs) {
      verdict.triggers.push("stall");
    }
    return verdict;
  }

  /**
   * A check-in about `triggers` was recorded for run `key`. Whatever the Lead answers, near_timeout
   * is done for the run, and stall waits for the timeline to move and then twice as long.
   */
  checkedIn(key: string, triggers: readonly WatchTrigger[]): void {
    const state = this.runs.get(key);
    if (!state) return;
    if (triggers.includes("near_timeout")) state.nearTimeoutDone = true;
    if (triggers.includes("stall")) {
      state.stallArmed = false;
      state.stallMs = 2 * STALL_MS;
    }
  }

  /** Drop the state of run `key`. */
  forget(key: string): void {
    this.runs.delete(key);
  }

  /** Drop the state of every run of the goal; keys are `<goal>:<run>`. */
  forgetGoal(goalId: string): void {
    for (const key of this.runs.keys()) if (key.startsWith(`${goalId}:`)) this.runs.delete(key);
  }
}

/** Remember when each running tool call was first seen; the one running longest, if any. */
function oldestRunningTool(
  state: RunWatch,
  cursor: TimelineCursor | null,
  now: number,
): { name: string; ms: number } | undefined {
  if (!cursor) return undefined;
  const running = new Set(cursor.runningTools.map((t) => t.callId));
  for (const callId of state.toolsSeenAt.keys()) {
    if (!running.has(callId)) state.toolsSeenAt.delete(callId);
  }
  let oldest: { name: string; ms: number } | undefined;
  for (const tool of cursor.runningTools) {
    const seenAt = state.toolsSeenAt.get(tool.callId) ?? now;
    state.toolsSeenAt.set(tool.callId, seenAt);
    if (!oldest || now - seenAt > oldest.ms) oldest = { name: tool.name, ms: now - seenAt };
  }
  return oldest;
}

/** Usage at or past WATCH_BUDGET_FRACTION of a budget; check-ins are skipped then. */
export function nearBudget(goal: Pick<Goal, "usage" | "config">): boolean {
  const { maxTotalTokens, maxCostUsd } = resolveLimits(goal.config);
  const usage = goal.usage;
  if (!usage) return false;
  return (
    (maxTotalTokens !== null && usage.totalTokens >= WATCH_BUDGET_FRACTION * maxTotalTokens) ||
    (maxCostUsd !== null && usage.costUsd >= WATCH_BUDGET_FRACTION * maxCostUsd)
  );
}

/** What the watcher saw when it asked for a check-in; shown to the Lead. */
export interface CheckInContext {
  triggers: WatchTrigger[];
  /** Time since the worker's turn started; the run's time limit counts from there. */
  elapsedMs: number;
  quietMs: number;
  runningTool?: { name: string; ms: number };
  /** The worker's recent activity, capped. */
  activity: string;
  /** The last error in the worker's timeline, capped. */
  lastError?: string;
}

/** What the check-in handler needs from the Manager. */
export interface CheckInDeps {
  /** The goal as it is now. */
  goal(goalId: string): Goal | undefined;
  /** Records an event. Resolves with the reducer's refusal, or null when recorded (or already). */
  record(goalId: string, input: GoalEventInput): Promise<string | null>;
  /** Steer text into the run's worker turn without replacing it. */
  steer(
    goalId: string,
    runId: string,
    agentId: string,
    text: string,
  ): Promise<"steered" | "unavailable">;
  /** False when the run is past its time limit, or its turn is not live in this process. */
  stoppable(goalId: string, runId: string): boolean;
  /** Cancel the run's worker; the run fails as stopped by the Lead with `reason`. */
  stopRun(goalId: string, runId: string, reason: string): void;
  /** What the watcher saw, when this process asked for the check-in. */
  context(goalId: string, interventionId: string): CheckInContext | undefined;
  now(): number;
}

const TURNED_OFF_NOTE = "Lead interventions were turned off; nothing was done to the run";
const NOT_STOPPABLE_NOTE = "The run had already reached its time limit; it was not stopped";

type Resolve = (
  goal: Goal,
  intervention: LeadIntervention,
  outcome: string,
  extra?: Record<string, unknown>,
) => Promise<string | null>;

/**
 * Steer the Lead's message into the worker's turn. Pi queues a steer it reports unavailable,
 * so its message may still arrive; the note says so.
 */
async function nudge(
  deps: CheckInDeps,
  goal: Goal,
  intervention: LeadIntervention,
  run: AgentRun,
  message: string,
  reason: { note?: string },
  resolve: Resolve,
): Promise<void> {
  let steered: "steered" | "unavailable" = "unavailable";
  let problem = "";
  try {
    if (run.agentId) {
      steered = await deps.steer(goal.id, run.id, run.agentId, `${NUDGE_PREFIX}\n${message}`);
    }
  } catch (error) {
    problem = `: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (steered === "steered") {
    await resolve(goal, intervention, "nudged", { message, ...reason });
    return;
  }
  const maybeQueued =
    run.provider.split("/")[0] === "pi" && !problem ? " (it may still arrive after the turn)" : "";
  await resolve(goal, intervention, "ok", {
    note: `nudge unavailable: ${run.provider}${problem}${maybeQueued}`,
  });
}

/**
 * Check-ins on a running task: the Lead answers ok, nudge or stop. Every outcome only pumps;
 * a stop ends in the run's failure, and that failure wakes the Lead as any other does.
 */
export function checkInHandler(deps: CheckInDeps): InterventionHandler<CheckInDecision> {
  const resolve: Resolve = (goal, intervention, outcome, extra = {}) =>
    deps.record(goal.id, {
      id: `${goal.id}:intervention:${intervention.id}:resolved`,
      goalId: goal.id,
      type: "intervention.resolved",
      interventionId: intervention.id,
      outcome,
      ...extra,
    });
  return {
    decisionMs: CHECK_IN_DECISION_MS,
    // Asked once: a Lead that is busy, fails or is interrupted lets the run go on.
    maxTurns: 1,
    interruptedCounts: true,
    buildPrompt: (goal, intervention) =>
      buildCheckInPrompt(goal, intervention, {
        decisionMinutes: Math.round(CHECK_IN_DECISION_MS / 60_000),
        now: deps.now(),
        observed: deps.context(goal.id, intervention.id) ?? null,
      }),
    parse(text, intervention) {
      const decision = extractInterventionDecision(text, intervention);
      if (
        decision.decision !== "ok" &&
        decision.decision !== "nudge" &&
        decision.decision !== "stop"
      ) {
        throw new InterventionDecisionError('"decision" must be one of "ok", "nudge", "stop".');
      }
      return decision;
    },
    async apply(goal, intervention, decision) {
      const reason = decision.reason === undefined ? {} : { note: decision.reason };
      // Turned off while the Lead decided: the answer is recorded, nothing is done to the run.
      if (decision.decision !== "ok" && !deps.goal(goal.id)?.config?.leadInterventions) {
        await resolve(goal, intervention, "ok", { note: TURNED_OFF_NOTE });
        return;
      }
      if (decision.decision === "ok") {
        await resolve(goal, intervention, "ok", reason);
        return;
      }
      const run = goal.runs.find((r) => r.id === intervention.runId);
      // The run ended meanwhile; the reducer resolved the check-in with it.
      if (!run || run.status !== "running") return;
      if (decision.decision === "stop") {
        // A run already timing out fails as timed out; a stop would mislabel it.
        if (!deps.stoppable(goal.id, run.id)) {
          await resolve(goal, intervention, "ok", { note: NOT_STOPPABLE_NOTE });
          return;
        }
        const refusal = await resolve(goal, intervention, "stopped", reason);
        if (refusal === null) deps.stopRun(goal.id, run.id, decision.reason);
        return;
      }
      await nudge(deps, goal, intervention, run, decision.message, reason, resolve);
    },
    async fallback(goal, intervention, reason: InterventionFallback) {
      await deps.record(goal.id, {
        id: `${goal.id}:intervention:${intervention.id}:${reason.kind}`,
        goalId: goal.id,
        type: "intervention.resolved",
        interventionId: intervention.id,
        // An answer that could not be used twice lets the run go on, with the reason noted.
        outcome: reason.kind === "unusable" ? "ok" : reason.kind,
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
