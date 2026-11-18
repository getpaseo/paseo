import {
  PlanRevisionOpSchema,
  TaskSpecSchema,
  type Goal,
  type LeadIntervention,
  type RecoveryDecision,
  type TaskSpec,
} from "@getpaseo/protocol/goal/types";
import { z } from "zod";
import {
  MAX_DECISION_REASON_CHARS,
  MAX_NUDGE_CHARS,
  capText,
  interventionClass,
} from "@getpaseo/protocol/goal/interventions";
import { MAX_PLAN_REVISIONS } from "./goal-reducer.js";
import { PlanRevisionError, checkRecoveryDecision, diffDesiredPlan } from "./plan-revision.js";
import { TaskGraphError, validateTaskGraph } from "./task-graph.js";

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanParseError";
  }
}

const PlanSchema = z.object({ tasks: z.array(TaskSpecSchema).min(1) });

const FENCE = /```(?:json)?\s*([\s\S]*?)```/g;

/**
 * Reads the Lead's plan out of its final message: the last fenced JSON block,
 * either `{"tasks": [...]}` or a bare task array. The result is validated as a
 * task graph, so nothing unchecked reaches the log.
 */
export function extractPlan(
  text: string,
  knownProviders?: readonly string[],
  maxTasks?: number,
): TaskSpec[] {
  const parsed = lastFencedJson(text, (message) => new PlanParseError(message));

  const result = PlanSchema.safeParse(Array.isArray(parsed) ? { tasks: parsed } : parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new PlanParseError(
      `The plan does not match the schema at ${issue?.path.join(".") || "root"}: ${issue?.message}`,
    );
  }

  try {
    validateTaskGraph(result.data.tasks);
  } catch (error) {
    if (error instanceof TaskGraphError) {
      throw new PlanParseError(error.message);
    }
    throw error;
  }
  if (maxTasks !== undefined && result.data.tasks.length > maxTasks) {
    throw new PlanParseError(
      `The plan has ${result.data.tasks.length} tasks but at most ${maxTasks} are allowed. Combine related work into fewer tasks.`,
    );
  }
  if (knownProviders) {
    for (const task of result.data.tasks) {
      const provider = task.provider?.split("/")[0];
      if (provider && !knownProviders.includes(provider)) {
        throw new PlanParseError(
          `Task ${task.id} names unknown provider "${provider}". Use one of: ${knownProviders.join(", ")}, or omit provider.`,
        );
      }
    }
  }
  return result.data.tasks;
}

/** The last fenced JSON block of a message, parsed. Earlier blocks are drafts or quotes. */
function lastFencedJson(text: string, fail: (message: string) => Error): unknown {
  const blocks = [...text.matchAll(FENCE)].map((match) => match[1] ?? "");
  const candidate = blocks.at(-1);
  if (candidate === undefined) {
    throw fail("No fenced ```json block found in the message.");
  }
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw fail(
      `The JSON block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The Lead's reply to an intervention could not be used; the message is for its correction turn. */
export class InterventionDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterventionDecisionError";
  }
}

const JSON_FENCE_OPEN = /```json[^\S\n]*\n?/gi;

/**
 * The Lead's decision block, parsed: the last ```json fence, read up to the first closing ```
 * that leaves valid JSON, so ``` inside a JSON string (a task description with a code block)
 * does not cut it short. An earlier block is never used instead: it may be a draft. Without a
 * json fence, the last fence of any kind.
 */
function lastDecisionJson(text: string): unknown {
  const opening = [...text.matchAll(JSON_FENCE_OPEN)].at(-1);
  if (!opening) return lastFencedJson(text, (message) => new InterventionDecisionError(message));
  const start = (opening.index ?? 0) + opening[0].length;
  let lastError = "the block is not closed with ```";
  for (let end = text.indexOf("```", start); end !== -1; end = text.indexOf("```", end + 3)) {
    try {
      return JSON.parse(text.slice(start, end));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new InterventionDecisionError(`The JSON block is not valid JSON: ${lastError}`);
}

const Reason = z.string().trim().min(1);

const FailureDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("revise"),
    reason: Reason,
    ops: z.array(PlanRevisionOpSchema).min(1).optional(),
    tasks: z.array(TaskSpecSchema).min(1).optional(),
    remove: z.array(z.string().trim().min(1)).optional(),
  }),
  z.object({ decision: z.literal("continue"), reason: Reason }),
  z.object({ decision: z.literal("give_up"), reason: Reason }),
]);
export type FailureDecision = z.infer<typeof FailureDecisionSchema>;

const CheckInDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("ok"), reason: Reason.optional() }),
  z.object({ decision: z.literal("nudge"), message: Reason, reason: Reason.optional() }),
  z.object({ decision: z.literal("stop"), reason: Reason }),
]);
export type CheckInDecision = z.infer<typeof CheckInDecisionSchema>;

export type InterventionDecision = FailureDecision | CheckInDecision;

const DECISIONS = {
  failure: ["revise", "continue", "give_up"],
  check_in: ["ok", "nudge", "stop"],
} as const;

function decisionIssue(error: z.ZodError, allowed: readonly string[]): string {
  const issue = error.issues[0];
  if (issue?.path[0] === "decision") {
    return `"decision" must be one of ${allowed.map((d) => `"${d}"`).join(", ")}.`;
  }
  return `The decision does not match the format at ${issue?.path.join(".") || "root"}: ${issue?.message}`;
}

function capReason<T extends { reason?: string }>(decision: T): T {
  return decision.reason === undefined
    ? decision
    : { ...decision, reason: capText(decision.reason, MAX_DECISION_REASON_CHARS) };
}

/**
 * Reads the Lead's decision about an intervention out of its reply: the last fenced JSON block,
 * one object with a "decision". Which decisions are allowed depends on the intervention: after
 * a failure revise, continue or give_up; at a check-in ok, nudge or stop, and stop only when
 * the run nears its time limit. Throws InterventionDecisionError with a message the Lead can
 * act on in one correction turn.
 */
export function extractInterventionDecision(
  text: string,
  intervention: Pick<LeadIntervention, "trigger" | "triggers">,
): InterventionDecision {
  const parsed = lastDecisionJson(text);
  if (interventionClass(intervention) === "check_in") {
    const result = CheckInDecisionSchema.safeParse(parsed);
    if (!result.success) {
      throw new InterventionDecisionError(decisionIssue(result.error, DECISIONS.check_in));
    }
    const decision = result.data;
    if (decision.decision === "stop" && !intervention.triggers?.includes("near_timeout")) {
      throw new InterventionDecisionError(
        'Stop is allowed only when the run nears its time limit; answer "ok" or "nudge".',
      );
    }
    if (decision.decision === "nudge" && decision.message.length > MAX_NUDGE_CHARS) {
      throw new InterventionDecisionError(
        `The nudge message has ${decision.message.length} characters; the limit is ${MAX_NUDGE_CHARS}.`,
      );
    }
    return capReason(decision);
  }
  const result = FailureDecisionSchema.safeParse(parsed);
  if (!result.success) {
    throw new InterventionDecisionError(decisionIssue(result.error, DECISIONS.failure));
  }
  const decision = result.data;
  if (decision.decision === "revise") {
    const byOps = decision.ops !== undefined;
    const byTasks = decision.tasks !== undefined || decision.remove !== undefined;
    if (byOps === byTasks) {
      throw new InterventionDecisionError(
        'A revise decision gives "ops", or the desired plan as "tasks" with "remove"; give exactly one form.',
      );
    }
  }
  return capReason(decision);
}

const Hints = z.record(z.string().trim().min(1), z.string().trim().min(1));

const RecoveryReplySchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("retry"), reason: Reason, hints: Hints.optional() }),
  z.object({
    decision: z.literal("revise"),
    reason: Reason,
    ops: z.array(PlanRevisionOpSchema).min(1).optional(),
    tasks: z.array(TaskSpecSchema).min(1).optional(),
    remove: z.array(z.string().trim().min(1)).optional(),
    hints: Hints.optional(),
  }),
  z.object({ decision: z.literal("needs_person"), reason: Reason }),
  // Read as needs_person: only a person can decide to give the goal up.
  z.object({ decision: z.literal("unrecoverable"), reason: Reason }),
]);

const RECOVERY_REPLIES = ["retry", "revise", "needs_person"] as const;

/**
 * Reads the Lead's recovery decision out of its reply and checks it against the failed goal,
 * as recovery.decided will: the last ```json block, one object with a "decision" of retry
 * (with optional hints for the workers of failed or cancelled tasks), revise (ops, or the
 * desired plan as tasks and remove, with optional hints) or needs_person. "unrecoverable"
 * reads as needs_person. Throws InterventionDecisionError with a message the Lead can act on.
 */
export function extractRecoveryDecision(
  text: string,
  goal: Goal,
  interventionId: string | undefined,
): RecoveryDecision {
  const result = RecoveryReplySchema.safeParse(lastDecisionJson(text));
  if (!result.success) {
    throw new InterventionDecisionError(decisionIssue(result.error, RECOVERY_REPLIES));
  }
  const reply = capReason(result.data);
  if (reply.decision === "needs_person" || reply.decision === "unrecoverable") {
    return { decision: "needs_person", reason: reply.reason };
  }
  const decision: RecoveryDecision = {
    decision: reply.decision,
    reason: reply.reason,
    ...(reply.hints ? { hints: reply.hints } : {}),
  };
  try {
    if (reply.decision === "revise") {
      const byOps = reply.ops !== undefined;
      const byTasks = reply.tasks !== undefined || reply.remove !== undefined;
      if (byOps === byTasks) {
        throw new InterventionDecisionError(
          'A revise decision gives "ops", or the desired plan as "tasks" with "remove"; give exactly one form.',
        );
      }
      if ((goal.planRevisions?.length ?? 0) >= MAX_PLAN_REVISIONS) {
        throw new InterventionDecisionError(
          `The plan was already revised ${MAX_PLAN_REVISIONS} times and cannot change again. Answer "retry" or "needs_person".`,
        );
      }
      decision.ops = reply.ops ?? diffDesiredPlan(goal, reply.tasks ?? [], reply.remove ?? []);
    }
    checkRecoveryDecision(goal, decision, interventionId);
  } catch (error) {
    if (error instanceof PlanRevisionError) throw new InterventionDecisionError(error.message);
    throw error;
  }
  return decision;
}
