import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { goalActiveMs } from "@getpaseo/protocol/goal/active-time";
import {
  diagnoseGoalFailure,
  type BlockingLimit,
  type GoalDiagnosis,
} from "@getpaseo/protocol/goal/diagnosis";
import { RECOVERY_DECISION_MS } from "@getpaseo/protocol/goal/interventions";
import { goalTimeoutMs } from "@getpaseo/protocol/goal/time-limit";
import type { Goal, GoalEvent, GoalTimeMode, Recovery } from "@getpaseo/protocol/goal/types";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";
import { formatDuration } from "./progress.js";
import { connectGoalClient, toGoalCommandError, type GoalCommandOptions } from "./shared.js";
import {
  askTimeMode,
  isTimeLimitRefusal,
  parseGuidance,
  parseTimeMode,
  refuseInAgentShell,
  terminalQuestion,
} from "./transition.js";

type GoalClient = Awaited<ReturnType<typeof connectGoalClient>>;

/** The `paseo goal config` flag that sets each limit. */
const LIMIT_FLAGS: Record<BlockingLimit["limit"], string> = {
  goalTimeoutMinutes: "--goal-timeout",
  deadlineAt: "--deadline",
  maxRuns: "--max-runs",
  maxTotalTokens: "--max-tokens",
  maxCostUsd: "--max-cost",
};

/** One line per limit that blocks: what is set, what was used, and the command that unblocks it. */
export function describeBlockingLimits(goalId: string, limits: readonly BlockingLimit[]): string[] {
  return limits.map((limit) => {
    const used = limit.used === undefined ? "" : `, ${limit.used} used`;
    const fix =
      limit.minimum === undefined
        ? ""
        : `; at least ${limit.minimum}: paseo goal config ${goalId} ${LIMIT_FLAGS[limit.limit]} ${limit.minimum}`;
    const note = limit.note ? ` (${limit.note})` : "";
    return `${limit.limit}: ${limit.current ?? "none"}${used}${fix}${note}`;
  });
}

/** The time the goal ran, as the daemon would record it for time mode remaining. */
function activeMsOf(events: readonly GoalEvent[], now: number): number | undefined {
  const ms = Math.round(goalActiveMs(events, now));
  return Number.isFinite(ms) ? ms : undefined;
}

/** What a time mode means for this goal, in words. */
export function describeTimeMode(
  goal: Goal,
  timeMode: string | undefined,
  activeMs?: number,
): string {
  const limit = goalTimeoutMs(goal);
  if (timeMode === "fresh") {
    return `fresh: the full ${formatDuration(limit)} from when the recovery is applied`;
  }
  if (timeMode === "remaining") {
    if (activeMs === undefined) return "remaining: the time left when it failed";
    return `remaining: ${formatDuration(activeMs)} ran of ${formatDuration(limit)}; ${formatDuration(Math.max(0, limit - activeMs))} left after the recovery is applied`;
  }
  return "unchanged: the time limit keeps counting as before";
}

/** The diagnosis as a person reads it. */
export function renderDiagnosis(goal: Goal, diagnosis: GoalDiagnosis, activeMs?: number): string {
  const lines = [
    `Goal ${goal.id} (${goal.status}): ${diagnosis.failureReason ?? "no reason recorded"}`,
  ];
  if (diagnosis.failedAt) lines.push(`Failed at: ${diagnosis.failedAt}`);
  if (diagnosis.timePassedAtFailure === true) {
    lines.push("The time limit had passed when it failed.");
  } else if (diagnosis.timePassedAtFailure === null && diagnosis.timePassedNow) {
    lines.push("The time limit is past now (when it failed is not recorded).");
  }
  lines.push(`Kind: ${diagnosis.kind}`, "", "Findings:");
  for (const finding of diagnosis.findings) {
    lines.push(`  - ${finding.kind} (person needed: ${finding.personNeeded}): ${finding.remedy}`);
  }
  if (diagnosis.tasks.length > 0) {
    lines.push("", "Tasks:");
    for (const task of diagnosis.tasks) {
      const blocks = task.blockedDependents.length
        ? `; blocks ${task.blockedDependents.join(", ")}`
        : "";
      lines.push(
        `  ${task.taskId} ${task.status}, ${task.cause}: ${task.failedRuns} failed (${task.countedFailures} counted), ${task.interruptedRuns} interrupted${blocks}`,
      );
      if (task.lastError) lines.push(`    last error: ${task.lastError.split("\n")[0]}`);
    }
  }
  if (diagnosis.blocked.length > 0) lines.push(`Blocked: ${diagnosis.blocked.join(", ")}`);
  if (diagnosis.unchanged.length > 0) {
    lines.push(`Finished without changes (information): ${diagnosis.unchanged.join(", ")}`);
  }
  if (diagnosis.openChangeSets.length > 0) {
    const open = diagnosis.openChangeSets.map((c) => `${c.id} (${c.taskId}, ${c.status})`);
    lines.push(`Open change sets: ${open.join(", ")}`);
  }
  if (diagnosis.merged.length > 0) {
    const merged = diagnosis.merged.map((m) => `${m.taskId} (${m.changeSetId})`);
    lines.push(`Merged: ${merged.join(", ")}`);
  }
  lines.push(`Runs: ${diagnosis.runs.used} of ${diagnosis.runs.max}`);
  if (activeMs !== undefined) {
    lines.push(`Time ran: ${formatDuration(activeMs)} of ${formatDuration(goalTimeoutMs(goal))}`);
  }
  if (diagnosis.blockingLimits.length > 0) {
    lines.push(
      "",
      "Blocking limits (recover never raises them; change them first):",
      ...describeBlockingLimits(goal.id, diagnosis.blockingLimits).map((line) => `  - ${line}`),
    );
  }
  lines.push("", ...nextSteps(goal, diagnosis));
  return lines.join("\n");
}

/** What the person can do next, as commands. */
function nextSteps(goal: Goal, diagnosis: GoalDiagnosis): string[] {
  if (
    goal.recovery &&
    ["deciding", "decided", "awaiting_approval"].includes(goal.recovery.status)
  ) {
    return [`Recovery ${goal.recovery.id}: ${recoveryNext(goal, goal.recovery)}`];
  }
  if (!diagnosis.recoverable) {
    const branch = goal.integration?.branch;
    return [
      `It cannot be recovered in place. Start a new goal${branch ? ` from branch ${branch}` : ""}.`,
    ];
  }
  if (goal.tasks.length === 0) {
    return [`It failed before it had a plan: paseo goal retry ${goal.id} after fixing the cause.`];
  }
  const time = diagnosis.timePassedNow ? " --time fresh|remaining" : "";
  return [
    `Recover: paseo goal recover ${goal.id}${time} [--prompt "..."] [--task <taskId>="..."]`,
    `Or retry without the Lead: paseo goal retry ${goal.id}${time}`,
  ];
}

export async function runDiagnoseCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalDiagnosis>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const { goal, events, error } = await client.goalInspect(id);
    if (error || !goal) throw new Error(error ?? `Goal not found: ${id}`);
    if (goal.status !== "failed") {
      throw new Error(`Goal ${id} is ${goal.status}; only a failed goal is diagnosed`);
    }
    const now = Date.now();
    const activeMs = activeMsOf(events, now);
    const diagnosis = diagnoseGoalFailure(goal, {
      now,
      ...(activeMs === undefined ? {} : { activeMs }),
    });
    return {
      type: "single",
      data: diagnosis,
      schema: {
        idField: "kind",
        columns: [],
        renderHuman: () => renderDiagnosis(goal, diagnosis, activeMs),
        serialize: (data) => ({ goalId: goal.id, activeMs: activeMs ?? null, ...data }),
      },
    };
  } catch (error) {
    throw toGoalCommandError("GOAL_DIAGNOSE_FAILED", "diagnose goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export interface GoalRecoverOptions extends GoalCommandOptions {
  prompt?: string;
  task?: string[];
  time?: string;
  cancel?: boolean;
  approve?: boolean;
  reject?: boolean;
  message?: string;
}

export interface RecoveryRow {
  goalId: string;
  recoveryId: string;
  status: string;
  outcome: string;
  time: string;
  /** What happens next, and what the person can do. */
  next: string;
}

const recoverySchema: OutputSchema<RecoveryRow> = {
  idField: "recoveryId",
  columns: [
    { header: "RECOVERY", field: "recoveryId", width: 12 },
    { header: "STATUS", field: "status", width: 18 },
    { header: "OUTCOME", field: "outcome", width: 13 },
    { header: "TIME", field: "time", width: 40 },
    { header: "NEXT", field: "next", width: 80 },
  ],
};

/** What follows a recovery in this state. */
export function recoveryNext(goal: Goal, recovery: Recovery): string {
  const minutes = Math.round(RECOVERY_DECISION_MS / 60_000);
  switch (recovery.status) {
    case "deciding":
      return `a fresh Lead is deciding (up to ${minutes} minutes; without an answer the failed tasks are retried with your instruction). Watch with paseo goal diagnose ${goal.id}; stop with paseo goal recover ${goal.id} --cancel`;
    case "awaiting_approval":
      return `the Lead's plan change waits for you: paseo goal inspect ${goal.id} --json shows it; paseo goal recover ${goal.id} --approve or --reject`;
    case "decided":
      return "the Lead's decision is being applied; the goal reopens shortly";
    case "applied":
      return `applied; the goal is ${goal.status} again`;
    default:
      return `ended (${recovery.outcome ?? "unknown"}): ${goal.failureReason ?? recovery.reason ?? "-"}`;
  }
}

/** The recovery the reply shows, as a row. */
export function toRecoveryRow(goal: Goal, recoveryId?: string): RecoveryRow {
  const recovery = goal.recovery;
  if (!recovery || (recoveryId !== undefined && recovery.id !== recoveryId)) {
    throw new Error(`Daemon returned no recovery${recoveryId ? ` ${recoveryId}` : ""}`);
  }
  return {
    goalId: goal.id,
    recoveryId: recovery.id,
    status: recovery.status,
    outcome: recovery.outcome ?? "-",
    time: describeTimeMode(goal, recovery.timeMode, recovery.activeMs),
    next: recoveryNext(goal, recovery),
  };
}

function recoveryResult(row: RecoveryRow): SingleResult<RecoveryRow> {
  return { type: "single", data: row, schema: recoverySchema };
}

function goalOf(payload: { goal: Goal | null; error: string | null }): Goal {
  if (payload.error || !payload.goal) throw new Error(payload.error ?? "Daemon returned no goal");
  return payload.goal;
}

/** A refusal, with the limits that block the goal and how to raise them; recover never does. */
async function withBlockingLimits(client: GoalClient, id: string, error: unknown): Promise<Error> {
  const message = error instanceof Error ? error.message : String(error);
  const inspected = await client.goalInspect(id).catch(() => null);
  if (!inspected?.goal || inspected.goal.status !== "failed") return new Error(message);
  const now = Date.now();
  const activeMs = activeMsOf(inspected.events, now);
  const { blockingLimits } = diagnoseGoalFailure(inspected.goal, {
    now,
    ...(activeMs === undefined ? {} : { activeMs }),
  });
  if (blockingLimits.length === 0) return new Error(message);
  const lines = describeBlockingLimits(id, blockingLimits).map((line) => `  - ${line}`);
  return new Error(`${message}\nBlocking limits (recover never raises them):\n${lines.join("\n")}`);
}

/** The flags chosen: start a recovery, or decide or cancel the one open. */
function recoverAction(options: GoalRecoverOptions): "start" | "cancel" | "approve" | "reject" {
  const decisions = [options.cancel, options.approve, options.reject].filter(Boolean).length;
  if (decisions > 1) throw new Error("Give one of --cancel, --approve and --reject");
  const starting =
    options.prompt !== undefined || (options.task?.length ?? 0) > 0 || options.time !== undefined;
  if (decisions === 1 && starting) {
    throw new Error(
      "--prompt, --task and --time start a recovery; they do not go with --cancel, --approve or --reject",
    );
  }
  if (options.message !== undefined && !options.reject) {
    throw new Error("--message goes with --reject");
  }
  if (options.cancel) return "cancel";
  if (options.approve) return "approve";
  if (options.reject) return "reject";
  return "start";
}

async function openRecovery(client: GoalClient, id: string): Promise<Recovery> {
  const { goal, error } = await client.goalInspect(id);
  if (error || !goal) throw new Error(error ?? `Goal not found: ${id}`);
  if (!goal.recovery) throw new Error(`Goal ${id} has no recovery`);
  return goal.recovery;
}

/**
 * `paseo goal recover`: ask a fresh Lead to decide how a failed goal continues, or decide or
 * cancel the recovery open. Refused in an agent's shell. Exits non-zero when the daemon refuses,
 * and when an approval ends the recovery for a person instead of applying it.
 */
export async function runRecoverCommand(
  id: string,
  options: GoalRecoverOptions,
  _command: Command,
): Promise<SingleResult<RecoveryRow>> {
  let action: ReturnType<typeof recoverAction>;
  try {
    refuseInAgentShell("paseo goal recover");
    action = recoverAction(options);
  } catch (error) {
    throw toGoalCommandError("GOAL_RECOVER_FAILED", "recover goal", error);
  }
  const client = await connectGoalClient(options.daemonTarget);
  try {
    if (action === "start") return recoveryResult(await startRecovery(client, id, options));
    const recovery = await openRecovery(client, id);
    if (action === "cancel") {
      const goal = goalOf(await client.goalRecoveryCancel({ goalId: id, recoveryId: recovery.id }));
      return recoveryResult(toRecoveryRow(goal, recovery.id));
    }
    const goal = goalOf(
      await client.goalRecoveryDecide({
        goalId: id,
        recoveryId: recovery.id,
        approve: action === "approve",
        ...(options.message ? { message: options.message } : {}),
      }),
    );
    const row = toRecoveryRow(goal, recovery.id);
    if (action === "approve" && goal.recovery?.outcome === "needs_person") {
      throw {
        code: "GOAL_RECOVERY_NOT_APPLIED",
        message: `Recovery ${recovery.id} was not applied: ${goal.failureReason ?? "a person must act"}`,
        details: row,
      } satisfies CommandError;
    }
    return recoveryResult(row);
  } catch (error) {
    throw toGoalCommandError("GOAL_RECOVER_FAILED", "recover goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

async function startRecovery(
  client: GoalClient,
  id: string,
  options: GoalRecoverOptions,
): Promise<RecoveryRow> {
  const guidance = parseGuidance(options.prompt, options.task, "--task");
  const eventId = randomUUID();
  const start = async (timeMode: GoalTimeMode | undefined) =>
    goalOf(
      await client.goalRecoveryStart({
        goalId: id,
        ...(timeMode ? { timeMode } : {}),
        ...(guidance ? { guidance } : {}),
        eventId,
      }),
    );
  const timeMode = parseTimeMode(options.time);
  let goal: Goal;
  try {
    goal = await start(timeMode);
  } catch (error) {
    if (timeMode || !isTimeLimitRefusal(error)) throw await withBlockingLimits(client, id, error);
    if (!client.supportsGoalTimeBase()) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}. Update the host to choose how a recovered goal's time limit restarts.`,
        { cause: error },
      );
    }
    const chosen = await askTimeMode(error, terminalQuestion(options));
    if (!chosen) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; rerun with --time fresh or --time remaining`,
        { cause: error },
      );
    }
    goal = await start(chosen).catch(async (retryError) => {
      throw await withBlockingLimits(client, id, retryError);
    });
  }
  return toRecoveryRow(goal);
}
