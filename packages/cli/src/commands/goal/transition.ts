import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  GOAL_TIME_LIMIT_PASSED,
  GOAL_TIME_MODES,
  PlanRevisionOpSchema,
  TaskSpecSchema,
  type Goal,
  type GoalTimeMode,
  type GuidanceChanges,
  type PlanRevisionOp,
  type TaskSpec,
} from "@getpaseo/protocol/goal/types";
import { z } from "zod";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";
import {
  connectGoalClient,
  goalSchema,
  toGoalCommandError,
  toGoalRow,
  type GoalCommandOptions,
  type GoalRow,
} from "./shared.js";

export interface GoalPlanOptions extends GoalCommandOptions {
  file?: string;
}

export async function runPlanCommand(
  id: string,
  options: GoalPlanOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    if (!options.file) {
      throw new Error("--file is required");
    }
    const tasks = z.array(TaskSpecSchema).parse(JSON.parse(await readFile(options.file, "utf8")));
    const payload = await client.goalProposePlan({ goalId: id, tasks });
    return toResult(payload);
  } catch (error) {
    throw toGoalCommandError("GOAL_PLAN_FAILED", "propose plan", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runApproveCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalApprovePlan({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_APPROVE_FAILED", "approve plan", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runApproveChangeSetCommand(
  id: string,
  changeSetId: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalApproveChangeSet({ goalId: id, changeSetId }));
  } catch (error) {
    throw toGoalCommandError("GOAL_APPROVE_CHANGESET_FAILED", "approve change set", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export interface GoalRequestChangesOptions extends GoalCommandOptions {
  message?: string;
}

export async function runRequestChangesCommand(
  id: string,
  changeSetId: string,
  options: GoalRequestChangesOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    if (!options.message) {
      throw new Error("--message is required");
    }
    return toResult(
      await client.goalRequestChanges({ goalId: id, changeSetId, findings: options.message }),
    );
  } catch (error) {
    throw toGoalCommandError("GOAL_REQUEST_CHANGES_FAILED", "request changes", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runCancelCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalCancel({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_CANCEL_FAILED", "cancel goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export interface GoalRejectPlanOptions extends GoalCommandOptions {
  message?: string;
}

export async function runRejectPlanCommand(
  id: string,
  options: GoalRejectPlanOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(
      await client.goalRejectPlan({
        goalId: id,
        ...(options.message ? { feedback: options.message } : {}),
      }),
    );
  } catch (error) {
    throw toGoalCommandError("GOAL_REJECT_PLAN_FAILED", "reject plan", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export interface GoalRetryOptions extends GoalCommandOptions {
  task?: string;
  time?: string;
  /** The person's instruction for the goal's workers; empty clears it. */
  prompt?: string;
  /** `<taskId>=<text>` instructions for one task's worker each; an empty text clears it. */
  taskPrompt?: string[];
}

/** `--time`: how the time limit restarts. */
export function parseTimeMode(value: string | undefined): GoalTimeMode | undefined {
  if (value === undefined) return undefined;
  const mode = GOAL_TIME_MODES.find((m) => m === value.trim().toLowerCase());
  if (!mode) throw new Error(`--time must be ${GOAL_TIME_MODES.join(" or ")}`);
  return mode;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host refused a retry or recovery that chose no time mode because the time limit has passed. */
export function isTimeLimitRefusal(error: unknown): boolean {
  return errorText(error).includes(GOAL_TIME_LIMIT_PASSED);
}

export interface TimeModeQuestion {
  interactive: boolean;
  structured: boolean;
  ask(message: string): Promise<string>;
}

/**
 * When a retry was refused because the goal's time limit has passed, ask on a terminal how
 * to restart it. Null when the refusal was for something else, there is no terminal to ask
 * on, or the answer chose neither mode.
 */
export async function askTimeMode(
  error: unknown,
  question: TimeModeQuestion,
): Promise<GoalTimeMode | null> {
  if (!isTimeLimitRefusal(error)) return null;
  if (question.structured || !question.interactive) return null;
  const answer = (
    await question.ask(
      "The goal's time limit has passed. Restart it fresh (the full limit from now) or with the remaining time it had? [fresh/remaining/N] ",
    )
  )
    .trim()
    .toLowerCase();
  if (answer === "f" || answer === "fresh") return "fresh";
  if (answer === "r" || answer === "remaining") return "remaining";
  return null;
}

/** Asks on this process's terminal, unless the output is structured. */
export function terminalQuestion(options: GoalCommandOptions): TimeModeQuestion {
  return {
    interactive: process.stdin.isTTY === true,
    structured:
      options.json === true ||
      ["json", "yaml"].includes(options.format?.trim().toLowerCase() ?? ""),
    ask: async (message) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await prompt.question(message);
      } catch {
        return "";
      } finally {
        prompt.close();
      }
    },
  };
}

/**
 * The guidance flags as goal guidance changes: `--prompt` for the goal, `--task t7=text` for one
 * task. An empty text clears that entry. Undefined when no flag was given.
 */
export function parseGuidance(
  prompt: string | undefined,
  tasks: readonly string[] | undefined,
  flag: string,
): GuidanceChanges | undefined {
  const byTask: Record<string, string | null> = {};
  for (const entry of tasks ?? []) {
    const at = entry.indexOf("=");
    const taskId = at < 0 ? "" : entry.slice(0, at).trim();
    if (!taskId) throw new Error(`${flag} must be <taskId>=<text>, got "${entry}"`);
    const text = entry.slice(at + 1).trim();
    byTask[taskId] = text ? text : null;
  }
  if (prompt === undefined && Object.keys(byTask).length === 0) return undefined;
  return {
    ...(prompt === undefined ? {} : { goal: prompt.trim() ? prompt.trim() : null }),
    ...(Object.keys(byTask).length > 0 ? { tasks: byTask } : {}),
  };
}

/**
 * Guidance and recoveries are a person's. A command run from an agent's shell, where
 * PASEO_AGENT_ID is set, refuses them; an agent that unsets the variable is not stopped.
 */
export function refuseInAgentShell(what: string): void {
  const agentId = process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) return;
  throw {
    code: "GOAL_PERSON_ONLY",
    message: `${what} is for a person, and PASEO_AGENT_ID is set (agent ${agentId}). Ask the person to run it from their own terminal.`,
  } satisfies CommandError;
}

const REWORK_WAITING_STATUSES: ReadonlySet<string> = new Set([
  "changes_requested",
  "conflicted",
  "test_failed",
]);

/**
 * What a retry reworked again, one line per change set. The retry's own event is the goal's
 * latest, so a change set it moved back to waiting for rework carries the goal's `updatedAt`.
 */
export function reopenedReworks(goal: Pick<Goal, "updatedAt" | "changeSets" | "tasks">): string[] {
  return goal.changeSets
    .filter((c) => REWORK_WAITING_STATUSES.has(c.status) && c.updatedAt === goal.updatedAt)
    .map((c) => {
      const task = goal.tasks.findLast((t) => t.rework?.changeSetId === c.id);
      return `Reopens the rework of ${c.id}${task ? ` (task ${task.id})` : ""}`;
    });
}

export async function runRetryCommand(
  id: string,
  options: GoalRetryOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  let guidance: GuidanceChanges | undefined;
  try {
    guidance = parseGuidance(options.prompt, options.taskPrompt, "--task-prompt");
    if (guidance) refuseInAgentShell("Guidance on goal retry (--prompt, --task-prompt)");
  } catch (error) {
    throw toGoalCommandError("GOAL_RETRY_FAILED", "retry goal", error);
  }
  const client = await connectGoalClient(options.daemonTarget);
  const question = terminalQuestion(options);
  const retry = async (timeMode: GoalTimeMode | undefined) => {
    const payload = await client.goalRetry({
      goalId: id,
      ...(options.task ? { taskId: options.task } : {}),
      ...(timeMode ? { timeMode } : {}),
      ...(guidance ? { guidance } : {}),
    });
    const result = toResult(payload);
    if (payload.goal && !question.structured) {
      for (const line of reopenedReworks(payload.goal)) process.stderr.write(`${line}\n`);
    }
    return result;
  };
  try {
    const timeMode = parseTimeMode(options.time);
    try {
      return await retry(timeMode);
    } catch (error) {
      if (timeMode || !isTimeLimitRefusal(error)) throw error;
      if (!client.supportsGoalTimeBase()) {
        throw new Error(
          `${errorText(error)}. Update the host to choose how a retried goal's time limit restarts.`,
          { cause: error },
        );
      }
      const chosen = await askTimeMode(error, question);
      if (!chosen)
        throw new Error(`${errorText(error)}; rerun with --time fresh or --time remaining`, {
          cause: error,
        });
      return await retry(chosen);
    }
  } catch (error) {
    throw toGoalCommandError("GOAL_RETRY_FAILED", "retry goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runPauseCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalPause({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_PAUSE_FAILED", "pause goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runResumeCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalResume({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_RESUME_FAILED", "resume goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runAckCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalAcknowledge({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_ACK_FAILED", "acknowledge goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

const RevisionFileSchema = z.union([
  z.array(PlanRevisionOpSchema),
  z.object({ ops: z.array(PlanRevisionOpSchema), reason: z.string().optional() }).strict(),
  z
    .object({
      tasks: z.array(TaskSpecSchema),
      remove: z.array(z.string().trim().min(1)).optional(),
      reason: z.string().optional(),
    })
    .strict(),
]);

export interface PlanRevisionRequest {
  ops?: PlanRevisionOp[];
  tasks?: TaskSpec[];
  remove?: string[];
  reason: string;
  agentId?: string;
}

/**
 * Reads a revision file: an ops array, `{ops}`, or the desired plan as `{tasks, remove}`, each
 * with an optional `reason` that `--reason` overrides. `agentId` is the calling agent's own id
 * (PASEO_AGENT_ID); the daemon treats the goal's Lead as the Lead and refuses other agents.
 */
export function parseRevisionFile(
  text: string,
  options: { reason?: string; agentId?: string },
): PlanRevisionRequest {
  const parsed = RevisionFileSchema.parse(JSON.parse(text));
  const body = Array.isArray(parsed) ? { ops: parsed } : parsed;
  const reason = (options.reason ?? body.reason ?? "").trim();
  if (!reason) {
    throw new Error("Give a reason with --reason or a reason field in the file");
  }
  const agentId = options.agentId?.trim();
  return {
    ...("ops" in body ? { ops: body.ops } : { tasks: body.tasks, remove: body.remove ?? [] }),
    reason,
    ...(agentId ? { agentId } : {}),
  };
}

export interface GoalReviseOptions extends GoalCommandOptions {
  file?: string;
  reason?: string;
  /** Send no agent id, so the revision is a person's even inside an agent's shell. */
  asPerson?: boolean;
}

export interface PlanRevisionRow {
  goalId: string;
  revisionId: string;
  source: string;
  status: string;
  /** What the status means for the caller: applied, waiting for approval, or rejected. */
  outcome: string;
  reason: string;
  decisionReason: string;
}

const planRevisionSchema: OutputSchema<PlanRevisionRow> = {
  idField: "revisionId",
  columns: [
    { header: "REVISION", field: "revisionId", width: 42 },
    { header: "SOURCE", field: "source", width: 7 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "OUTCOME", field: "outcome", width: 40 },
    { header: "DECISION REASON", field: "decisionReason", width: 60 },
  ],
};

function revisionOutcome(status: string): string {
  switch (status) {
    case "applied":
      return "applied to the plan";
    case "pending":
      return "waiting for approval (paseo goal approve-revision)";
    case "rejected":
      return "rejected; the plan is unchanged";
    default:
      return status;
  }
}

/** The revision `revisionId` of the goal a mutation returned, as a row. */
export function toRevisionRow(
  payload: { goal: Goal | null; error: string | null },
  revisionId: string,
): PlanRevisionRow {
  if (payload.error || !payload.goal) {
    throw new Error(payload.error ?? "Daemon returned no goal");
  }
  const revision = payload.goal.planRevisions?.find((r) => r.id === revisionId);
  if (!revision) throw new Error(`Daemon returned no plan revision ${revisionId}`);
  return {
    goalId: payload.goal.id,
    revisionId: revision.id,
    source: revision.source,
    status: revision.status,
    outcome: revisionOutcome(revision.status),
    reason: revision.reason,
    decisionReason: revision.decisionReason ?? "-",
  };
}

function revisionResult(row: PlanRevisionRow): SingleResult<PlanRevisionRow> {
  return { type: "single", data: row, schema: planRevisionSchema };
}

export async function runReviseCommand(
  id: string,
  options: GoalReviseOptions,
  _command: Command,
): Promise<SingleResult<PlanRevisionRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    if (!options.file) {
      throw new Error("--file is required");
    }
    const request = parseRevisionFile(await readFile(options.file, "utf8"), {
      reason: options.reason,
      agentId: options.asPerson ? undefined : process.env.PASEO_AGENT_ID,
    });
    // The daemon names the revision after the event id, so the reply can be matched to it.
    const eventId = randomUUID();
    const row = toRevisionRow(
      await client.goalRevisePlan({ goalId: id, ...request, eventId }),
      `rev-${eventId}`,
    );
    if (row.status === "rejected") {
      throw {
        code: "GOAL_REVISION_REJECTED",
        message: `Plan revision ${row.revisionId} was rejected: ${row.decisionReason}`,
        details: row,
      } satisfies CommandError;
    }
    return revisionResult(row);
  } catch (error) {
    throw toGoalCommandError("GOAL_REVISE_FAILED", "revise plan", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export interface GoalRevisionDecisionOptions extends GoalCommandOptions {
  revision?: string;
  message?: string;
}

/** The named revision, or the one pending. */
export function revisionToDecide(goal: Pick<Goal, "id" | "planRevisions">, named?: string): string {
  if (named) return named;
  const pending = goal.planRevisions?.find((r) => r.status === "pending");
  if (!pending) throw new Error(`Goal ${goal.id} has no plan revision waiting for a decision`);
  return pending.id;
}

async function pendingRevisionId(
  client: Awaited<ReturnType<typeof connectGoalClient>>,
  id: string,
  named: string | undefined,
): Promise<string> {
  if (named) return named;
  const { goal, error } = await client.goalInspect(id);
  if (error || !goal) throw new Error(error ?? `Goal ${id} not found`);
  return revisionToDecide(goal);
}

export async function runApproveRevisionCommand(
  id: string,
  options: GoalRevisionDecisionOptions,
  _command: Command,
): Promise<SingleResult<PlanRevisionRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const revisionId = await pendingRevisionId(client, id, options.revision);
    return revisionResult(
      toRevisionRow(await client.goalApprovePlanRevision({ goalId: id, revisionId }), revisionId),
    );
  } catch (error) {
    throw toGoalCommandError("GOAL_APPROVE_REVISION_FAILED", "approve plan revision", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runRejectRevisionCommand(
  id: string,
  options: GoalRevisionDecisionOptions,
  _command: Command,
): Promise<SingleResult<PlanRevisionRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const revisionId = await pendingRevisionId(client, id, options.revision);
    return revisionResult(
      toRevisionRow(
        await client.goalRejectPlanRevision({
          goalId: id,
          revisionId,
          ...(options.message ? { feedback: options.message } : {}),
        }),
        revisionId,
      ),
    );
  } catch (error) {
    throw toGoalCommandError("GOAL_REJECT_REVISION_FAILED", "reject plan revision", error);
  } finally {
    await client.close().catch(() => {});
  }
}

function toResult(payload: { goal: Parameters<typeof toGoalRow>[0] | null; error: string | null }) {
  if (payload.error || !payload.goal) {
    throw new Error(payload.error ?? "Daemon returned no goal");
  }
  return { type: "single" as const, data: toGoalRow(payload.goal), schema: goalSchema };
}
