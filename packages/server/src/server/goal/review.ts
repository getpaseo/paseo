import type { ChangeSet, Goal, ReworkReason, Task } from "@getpaseo/protocol/goal/types";
import { z } from "zod";
import { WORKER_STATUS_LINES, quoteData } from "./prompts.js";

export class ReplyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyParseError";
  }
}

const FENCE = /```(?:json)?\s*([\s\S]*?)```/g;

/** The last fenced JSON block in an agent's reply, validated against a schema. */
export function parseJsonReply<T>(text: string, schema: z.ZodType<T>): T {
  const candidate = [...text.matchAll(FENCE)].at(-1)?.[1];
  if (candidate === undefined) {
    throw new ReplyParseError("No fenced ```json block found in the reply.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new ReplyParseError(
      `The JSON block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ReplyParseError(
      `The reply does not match the format at ${issue?.path.join(".") || "root"}: ${issue?.message}`,
    );
  }
  return result.data;
}

const VerdictSchema = z
  .object({
    verdict: z.enum(["approve", "request_changes"]),
    findings: z.array(z.string().trim().min(1)),
  })
  .refine((v) => v.verdict === "approve" || v.findings.length > 0, {
    message: "request_changes needs at least one finding",
    path: ["findings"],
  });
export type ReviewVerdict = z.infer<typeof VerdictSchema>;

export function parseVerdict(text: string): ReviewVerdict {
  return parseJsonReply(text, VerdictSchema);
}

export function buildReviewPrompt(goal: Goal, task: Task, changeSet: ChangeSet): string {
  const files = changeSet.files.map((f) => `${f.status}\t${f.path}`).join("\n") || "(none)";
  const criteria = goal.criteria.map((c) => `- ${c.text}`).join("\n") || "- (none given)";
  return [
    `You are an independent reviewer for one change made toward the goal "${goal.title}". You did not write it.`,
    "",
    `The change implements this task: ${task.title}`,
    task.description,
    "",
    `Acceptance criteria for the whole goal:\n${criteria}`,
    "",
    `Review exactly this change: base ${changeSet.baseCommit}, head ${changeSet.headCommit}.`,
    `Run \`git diff ${changeSet.baseCommit}..${changeSet.headCommit}\` in your working directory and read the changed files.`,
    `Changed files:\n${files}`,
    "",
    "Check that it does what the task asks, is correct, has no unrelated changes, and does not break existing behavior. You may run tests and read any file. Do not modify files and do not commit.",
    "Reply with a short explanation followed by exactly one fenced ```json block:",
    '{"verdict": "approve" | "request_changes", "findings": ["each problem, specific enough to fix"]}',
    "Use request_changes only for problems that must be fixed. findings may be empty only for approve.",
  ].join("\n");
}

export function buildReviewCorrectionPrompt(problem: string): string {
  return `Your reply could not be used: ${problem}\nReply again with one fenced \`\`\`json block in the format requested.`;
}

/** Describes what needs fixing, for the rework task's description. */
export function describeRework(changeSet: ChangeSet, reason: ReworkReason): string {
  switch (reason) {
    case "review":
      return quoteData("A reviewer asked for changes:", changeSet.findings ?? "(no details)");
    case "conflict":
      return quoteData(
        "Merging this change into the goal's integration branch conflicted:",
        changeSet.error ?? "(no details)",
      );
    case "tests":
      return quoteData(
        "The test command failed after merging this change into the goal's integration branch:",
        changeSet.testSummary ?? changeSet.error ?? "(no details)",
      );
  }
}

export function buildReworkPrompt(
  goal: Goal,
  task: Task,
  changeSet: ChangeSet,
  integrationBranch: string | null,
): string {
  const reason = task.rework?.reason ?? "review";
  const steps =
    reason === "review"
      ? "Address each finding in your existing branch and commit the fixes."
      : `Bring your branch up to date: run \`git merge ${integrationBranch ?? "the integration branch"}\`, resolve any conflicts, make sure the project builds and its tests pass, and commit the result.`;
  return [
    `You are fixing your earlier work on the goal "${goal.title}". You are in the same git worktree as before, on branch ${changeSet.branch}.`,
    `Original task: ${changeSet.taskId}`,
    "",
    task.description,
    "",
    steps,
    "End with a brief report of what you changed.",
    ...WORKER_STATUS_LINES,
  ].join("\n");
}

const VerificationSchema = z.object({
  criteria: z.array(
    z.object({ id: z.string(), met: z.boolean(), evidence: z.string().trim().min(1) }),
  ),
});
export type Verification = z.infer<typeof VerificationSchema>;

export function buildVerifyPrompt(goal: Goal, branch: string | null): string {
  const pending = goal.criteria.filter((c) => !c.verifiedAt);
  const list = pending.map((c) => `- ${c.id}: ${c.text}`).join("\n");
  return [
    `You are the verifier for the goal "${goal.title}". The work is finished and merged${branch ? ` on branch ${branch}, which is checked out here` : ""}.`,
    `Objective:\n${goal.objective || "(none given)"}`,
    "",
    `Check each acceptance criterion against the actual code and behavior. Run commands and tests where that is the only way to know. A criterion is met only if you observed it, not because a task says it is done.\n${list}`,
    "",
    "Do not modify files. Reply with a short explanation followed by exactly one fenced ```json block:",
    '{"criteria": [{"id": "c1", "met": true, "evidence": "what you ran or read, and what you saw"}]}',
    "Include every criterion listed above.",
  ].join("\n");
}

/** Every pending criterion must be answered, so a verifier cannot skip a hard one. */
export function parseVerification(text: string, expectedIds: readonly string[]): Verification {
  const verification = parseJsonReply(text, VerificationSchema);
  const answered = new Set(verification.criteria.map((c) => c.id));
  const missing = expectedIds.filter((id) => !answered.has(id));
  if (missing.length > 0) {
    throw new ReplyParseError(`Criteria not answered: ${missing.join(", ")}`);
  }
  const unknown = verification.criteria.filter((c) => !expectedIds.includes(c.id));
  if (unknown.length > 0) {
    throw new ReplyParseError(`Unknown criteria: ${unknown.map((c) => c.id).join(", ")}`);
  }
  return verification;
}
