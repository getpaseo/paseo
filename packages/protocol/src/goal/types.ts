import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";
import {
  GOAL_BRANCH_PREFIX_MAX_LENGTH,
  GOAL_BRANCH_PREFIX_PATTERN,
  GOAL_CONFIG_BOUNDS as B,
  GOAL_PERMISSION_POLICIES,
  type GoalNumberBound,
} from "./config-bounds.js";

function boundedInt(bound: GoalNumberBound) {
  return z.number().int().min(bound.min).max(bound.max);
}

export const GoalPermissionPolicySchema = z.enum(GOAL_PERMISSION_POLICIES);

export const GoalStatusSchema = z.enum([
  "planning",
  "awaiting_plan_approval",
  "executing",
  "completed",
  "failed",
  "cancelled",
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

// Advisory: orders goal lists and, when the daemon-wide run cap is full, decides which
// goal's ready task takes a freed slot first. Absent means "normal".
export const GoalPrioritySchema = z.enum(["low", "normal", "high"]);
export type GoalPriority = z.infer<typeof GoalPrioritySchema>;

export const TaskStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskKindSchema = z.enum(["implement", "review", "read"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

const IdSchema = z.string().trim().min(1);

export const TaskSpecSchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1),
  description: z.string(),
  kind: TaskKindSchema,
  dependsOn: z.array(IdSchema),
  provider: AgentProviderSchema.trim().min(1).optional(),
  // Thinking option id for this task's model. Overrides workerThinking.
  thinking: z.string().trim().min(1).optional(),
  // Turn time limit for this task's runs. It can only lower the goal's
  // limits.runTimeoutMinutes, so a plan cannot widen a limit a person set.
  runTimeoutMinutes: boundedInt(B.limits.runTimeoutMinutes).optional(),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const ReworkReasonSchema = z.enum(["review", "conflict", "tests"]);
export type ReworkReason = z.infer<typeof ReworkReasonSchema>;

export const ReworkSchema = z.object({
  changeSetId: IdSchema,
  reason: ReworkReasonSchema,
  round: z.number().int().positive(),
});
export type Rework = z.infer<typeof ReworkSchema>;

export const TaskSchema = TaskSpecSchema.extend({
  status: TaskStatusSchema,
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
  // The agent's final report for the last successful attempt.
  summary: z.string().nullable(),
  // Set on tasks the Manager added to fix a change set; they continue in its worktree.
  rework: ReworkSchema.optional(),
  // For an implement task: its work has been captured as a change set, or recorded as empty.
  captured: z.boolean().optional(),
  // Failed runs before the last retry a person asked for. They no longer count
  // against maxAttempts. Absent when the task was never retried by hand.
  forgivenFailures: z.number().int().nonnegative().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const GoalConfigSchema = z.object({
  // Repository the Lead plans against and implementation worktrees branch from.
  cwd: z.string().trim().min(1),
  // The commit checked out in `cwd` when the goal was created. Every worktree starts from
  // it, so the goal builds on the branch you were on, not on the repository's default.
  baseCommit: z.string().trim().min(1).optional(),
  leadProvider: AgentProviderSchema,
  // Used for tasks that do not name a provider.
  defaultProvider: AgentProviderSchema,
  maxParallel: boundedInt(B.maxParallel),
  maxAttempts: boundedInt(B.maxAttempts),
  autoApprovePlan: z.boolean(),
  // Send the Lead a message when a task fails for good or all tasks finish.
  notifyLead: z.boolean(),
  // Wake the Lead to decide what to do when a task times out, fails twice or uses its last
  // attempt, and when a running task nears its time limit or stalls. Absent means off, so
  // goals created before it keep running as they did. Needs
  // server_info.features.goalLeadInterventions.
  leadInterventions: z.boolean().optional(),
  // Provider for the independent reviewer, and for the verifier unless verifyProvider is set.
  // Defaults to the Lead's.
  reviewProvider: AgentProviderSchema.optional(),
  // Provider for the criteria verifier. Defaults to reviewProvider, then the Lead's.
  verifyProvider: AgentProviderSchema.optional(),
  // Thinking option ids (a model's thinkingOptions[].id) per role. Unset means the
  // model's own default. Each applies to its role only; see ./thinking.ts.
  leadThinking: z.string().trim().min(1).optional(),
  // Applies to worker runs on defaultProvider. A task's own `thinking` wins.
  workerThinking: z.string().trim().min(1).optional(),
  reviewThinking: z.string().trim().min(1).optional(),
  verifyThinking: z.string().trim().min(1).optional(),
  // Shell command run in the integration worktree after each merge. A non-zero exit rejects the merge.
  testCommand: z.string().trim().min(1).optional(),
  // Hold every reviewed change set until a person approves it.
  requireHumanApproval: z.boolean().optional(),
  // Review, conflict and test-failure rework rounds allowed per change.
  maxReworkRounds: boundedInt(B.maxReworkRounds).optional(),
  // The integration branch is `<branchPrefix>/<goalId>`. Defaults to DEFAULT_GOAL_BRANCH_PREFIX.
  branchPrefix: z
    .string()
    .trim()
    .min(1)
    .max(GOAL_BRANCH_PREFIX_MAX_LENGTH)
    .regex(GOAL_BRANCH_PREFIX_PATTERN)
    .optional(),
  limits: z
    .object({
      // Tasks in a plan.
      maxTasks: boundedInt(B.limits.maxTasks).optional(),
      // Agent runs over the goal's lifetime, retries and rework included.
      maxRuns: boundedInt(B.limits.maxRuns).optional(),
      // Wall-clock time for any one agent turn.
      runTimeoutMinutes: boundedInt(B.limits.runTimeoutMinutes).optional(),
      // Wall-clock time from creation until the goal must be finished.
      goalTimeoutMinutes: boundedInt(B.limits.goalTimeoutMinutes).optional(),
      // Longest one permission request or question may wait for a person's answer; past it
      // the run fails. Time spent waiting does not count toward runTimeoutMinutes or
      // goalTimeoutMinutes. Needs server_info.features.goalUserWait.
      userWaitMinutes: boundedInt(B.limits.userWaitMinutes).optional(),
      // Pause before a failed task is retried, multiplied by the attempt number.
      retryBackoffSeconds: boundedInt(B.limits.retryBackoffSeconds).optional(),
      // Input plus output tokens the providers report over the goal's life.
      maxTotalTokens: boundedInt(B.limits.maxTotalTokens).optional(),
      // US dollars the providers report over the goal's life.
      maxCostUsd: z.number().min(B.limits.maxCostUsd.min).max(B.limits.maxCostUsd.max).optional(),
      // ISO 8601 time the goal must be finished by, in addition to goalTimeoutMinutes.
      deadlineAt: z.string().trim().min(1).optional(),
    })
    .optional(),
  // What to do when an agent asks for a permission. `fail`: agents start in the provider's
  // unattended mode and a run that still asks fails. `wait`: agents start in the provider's
  // default mode and requests stay pending in Paseo for a person (bounded by
  // limits.userWaitMinutes). `auto`: like `wait`, but agents start in the provider's "auto" mode when it
  // lists one. Absent means `fail` (goals stored before `wait` became the default);
  // read it with goalPermissionPolicy. `auto` needs server_info.features.goalConfigEdit.
  onPermissionRequest: GoalPermissionPolicySchema.optional(),
  // The chat the goal was started from. Its outcome is posted back there when the goal ends.
  originAgentId: z.string().trim().min(1).optional(),
  // Providers the goal may use; a plan naming any other is sent back to the Lead.
  allowedProviders: z.array(AgentProviderSchema.trim().min(1)).min(1).optional(),
});
export type GoalConfig = z.infer<typeof GoalConfigSchema>;

// The settings goal.update_config can change after creation. Absent leaves a setting as it
// is; null clears an optional one (its default applies, or the budget or deadline is
// removed). Providers, models, thinking, cwd, branchPrefix, allowedProviders and the
// objective are fixed for the goal's life.
export const GoalConfigChangesSchema = z.object({
  onPermissionRequest: GoalPermissionPolicySchema.optional(),
  notifyLead: z.boolean().optional(),
  leadInterventions: z.boolean().optional(),
  autoApprovePlan: z.boolean().optional(),
  requireHumanApproval: z.boolean().optional(),
  testCommand: z.string().trim().min(1).nullable().optional(),
  maxParallel: boundedInt(B.maxParallel).optional(),
  maxAttempts: boundedInt(B.maxAttempts).optional(),
  maxReworkRounds: boundedInt(B.maxReworkRounds).nullable().optional(),
  limits: z
    .object({
      maxTasks: boundedInt(B.limits.maxTasks).nullable().optional(),
      maxRuns: boundedInt(B.limits.maxRuns).nullable().optional(),
      runTimeoutMinutes: boundedInt(B.limits.runTimeoutMinutes).nullable().optional(),
      goalTimeoutMinutes: boundedInt(B.limits.goalTimeoutMinutes).nullable().optional(),
      userWaitMinutes: boundedInt(B.limits.userWaitMinutes).nullable().optional(),
      retryBackoffSeconds: boundedInt(B.limits.retryBackoffSeconds).nullable().optional(),
      maxTotalTokens: boundedInt(B.limits.maxTotalTokens).nullable().optional(),
      maxCostUsd: z
        .number()
        .min(B.limits.maxCostUsd.min)
        .max(B.limits.maxCostUsd.max)
        .nullable()
        .optional(),
      deadlineAt: z.string().trim().min(1).nullable().optional(),
    })
    .optional(),
});
export type GoalConfigChanges = z.infer<typeof GoalConfigChangesSchema>;

export const RunStatusSchema = z.enum(["running", "succeeded", "failed", "interrupted"]);

// What a provider reported for one agent turn. Any field may be missing: providers
// report different subsets, and some report nothing. Daemons from v0.13.3 record every
// provider the same way: `inputTokens` is fresh input (cache writes included, cache reads
// not), `cachedInputTokens` is input read from the prompt cache, and every field covers
// the whole turn. Earlier daemons stored what the provider sent: Codex input included
// cache reads and covered only the turn's last model call, and Claude cost was the
// session's running total.
export const TurnUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type TurnUsage = z.infer<typeof TurnUsageSchema>;

// Usage summed over turns. `reportedTurns` of `totalTurns` agent turns came with usage;
// the totals cover only those.
export const UsageTotalsSchema = z.object({
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  // inputTokens + outputTokens, cache reads excluded; what limits.maxTotalTokens is checked against.
  totalTokens: z.number().nonnegative(),
  // Only what providers reported; a turn without a cost adds nothing.
  costUsd: z.number().nonnegative(),
  reportedTurns: z.number().int().nonnegative(),
  totalTurns: z.number().int().nonnegative(),
  // Turns that reported a cost, and turns that reported a token count. Fewer than
  // totalTurns means the matching total is a lower bound. Absent from daemons before v0.13.3.
  costReportedTurns: z.number().int().nonnegative().optional(),
  tokenReportedTurns: z.number().int().nonnegative().optional(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageRoleSchema = z.enum(["lead", "worker", "reviewer", "verifier"]);
export type UsageRole = z.infer<typeof UsageRoleSchema>;

// Usage of one agent over all its turns. Retries and reworks start new agents, so they
// are separate entries.
export const UsageBreakdownEntrySchema = z.object({
  agentId: z.string(),
  role: UsageRoleSchema,
  // A worker's task and run; a reviewer's change set and its task.
  taskId: z.string().optional(),
  runId: z.string().optional(),
  changeSetId: z.string().optional(),
  // Provider id and model, split from the goal's "provider/model" setting; model is absent
  // when the setting names the provider only.
  provider: z.string().optional(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  usage: UsageTotalsSchema,
  firstAt: z.string(),
  lastAt: z.string(),
});
export type UsageBreakdownEntry = z.infer<typeof UsageBreakdownEntrySchema>;

// Usage totals per role. A role is absent until one of its turns is recorded.
export const UsageByRoleSchema = z.object({
  lead: UsageTotalsSchema.optional(),
  worker: UsageTotalsSchema.optional(),
  reviewer: UsageTotalsSchema.optional(),
  verifier: UsageTotalsSchema.optional(),
});
export type UsageByRole = z.infer<typeof UsageByRoleSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;

// One execution attempt of a task by one agent. Tracked apart from the task so
// retries and interrupted attempts stay in the history.
export const AgentRunSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  provider: AgentProviderSchema,
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  // Working directory of the run, so its work can be captured after a restart.
  cwd: z.string().nullable().optional(),
  status: RunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  error: z.string().nullable(),
  // Usage of this run's turns. Absent until a turn of the run is recorded.
  usage: UsageTotalsSchema.optional(),
  // Thinking option the run's agent started with. Absent when neither the goal nor the
  // provider named one, and from daemons that predate goal thinking.
  thinking: z.string().optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: IdSchema,
  text: z.string().trim().min(1),
  verifiedAt: z.string().nullable(),
  // What the verifier observed.
  evidence: z.string().nullable(),
  // Set when a person accepted the failed goal as is without this criterion being verified
  // (goal.accepted), with their note. Absent otherwise, from daemons without
  // server_info.features.goalAccept, and for clients without the goal_accept capability.
  waived: z.object({ at: z.string(), note: z.string() }).optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/** Longest note a person may give when accepting a failed goal as is. */
export const MAX_ACCEPT_NOTE_CHARS = 2000;

// How a person accepted a failed goal as is (goal.accepted). `from` is the failure reason the
// goal had at that moment; `client` is "app" or "cli", a string so a later value does not break
// an older reader.
export const GoalAcceptanceSchema = z.object({
  at: z.string(),
  note: z.string(),
  from: z.string(),
  client: z.string(),
});
export type GoalAcceptance = z.infer<typeof GoalAcceptanceSchema>;

/** `ChangeSet.rejectionReason` and the transition's `reason` when the merge step failed. */
export const CHANGE_SET_INTEGRATION_FAILED = "integration_failed";
/**
 * The rejection reason when the change set's rework task failed for good. A retry or recovery
 * that reopens the goal reopens the change set, and its rework runs again.
 */
export const CHANGE_SET_REWORK_FAILED = "rework_failed";
/** The rejection reason when the change set still needed fixes after maxReworkRounds. Final. */
export const CHANGE_SET_REWORK_LIMIT = "rework_limit";

export const ChangeSetStatusSchema = z.enum([
  "captured",
  "in_review",
  "awaiting_human",
  "approved",
  "integrating",
  "integrated",
  "changes_requested",
  "conflicted",
  "test_failed",
  "superseded",
  "rejected",
]);
export type ChangeSetStatus = z.infer<typeof ChangeSetStatusSchema>;

export const ChangedFileSchema = z.object({ path: z.string(), status: z.string() });
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

// The work of one successful implement run, pinned to explicit commits.
export const ChangeSetSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  runId: IdSchema,
  // 0 for the original change, then one more per rework.
  round: z.number().int().nonnegative(),
  supersedes: z.string().nullable(),
  workspaceId: z.string(),
  cwd: z.string(),
  branch: z.string(),
  baseCommit: z.string(),
  headCommit: z.string(),
  files: z.array(ChangedFileSchema),
  status: ChangeSetStatusSchema,
  findings: z.string().nullable(),
  testSummary: z.string().nullable(),
  integratedCommit: z.string().nullable(),
  error: z.string().nullable(),
  // Why a rejected change set was rejected, when it is known. CHANGE_SET_INTEGRATION_FAILED
  // marks a change set whose merge step failed after review and approval; with
  // server_info.features.goalIntegrationRetry a retry merges it again. CHANGE_SET_REWORK_FAILED
  // marks one whose rework task failed for good; with goalReworkRetry a retry or recovery
  // reopens it. CHANGE_SET_REWORK_LIMIT is final. Absent otherwise.
  rejectionReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Stage times, set by the reducer from changeset.transitioned events. Absent until the
  // stage is reached, and from daemons that predate them.
  // Entered in_review.
  reviewStartedAt: z.string().optional(),
  // Left in_review with a verdict: approved, held for a person, changes requested or rejected.
  reviewedAt: z.string().optional(),
  // First entered integrating.
  mergeStartedAt: z.string().optional(),
  // Reached integrated.
  mergedAt: z.string().optional(),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

// The goal's own branch and worktree, where approved change sets are merged.
export const IntegrationSchema = z.object({
  branch: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  baseCommit: z.string(),
  headCommit: z.string(),
});
export type Integration = z.infer<typeof IntegrationSchema>;

export const NotificationTargetSchema = z.enum(["lead", "origin"]);
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;

export const NotificationStatusSchema = z.enum(["pending", "delivered", "failed"]);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

// A message the Manager sends an agent: the Lead, or the chat the goal was started from.
// `delivered` means the agent layer accepted the prompt, not that anyone read it.
export const NotificationSchema = z.object({
  // Unique per target within a goal.
  key: z.string().min(1),
  target: NotificationTargetSchema,
  // The exact text sent on every attempt.
  text: z.string(),
  status: NotificationStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
});
export type Notification = z.infer<typeof NotificationSchema>;

// A plan a person sent back to the Lead, and why.
export const PlanRejectionSchema = z.object({
  reason: z.string(),
  tasks: z.array(TaskSpecSchema),
  at: z.string(),
});
export type PlanRejection = z.infer<typeof PlanRejectionSchema>;

// One change to an executing goal's plan. `replace` names an existing task by the spec's id.
export const PlanRevisionOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), task: TaskSpecSchema }),
  z.object({ op: z.literal("replace"), task: TaskSpecSchema }),
  z.object({ op: z.literal("remove"), taskId: IdSchema }),
]);
export type PlanRevisionOp = z.infer<typeof PlanRevisionOpSchema>;

// A change to the plan after it was approved, proposed by the Lead or a person.
// `source` is "lead" or "person"; `status` is "pending", "applied", "rejected",
// "abandoned" or "superseded". Both are strings so a later value does not break an older reader.
export const PlanRevisionSchema = z.object({
  id: IdSchema,
  source: z.string(),
  reason: z.string(),
  ops: z.array(PlanRevisionOpSchema),
  status: z.string(),
  // The Lead intervention this revision answers.
  interventionId: IdSchema.optional(),
  proposedAt: z.string(),
  decidedAt: z.string().optional(),
  decisionReason: z.string().optional(),
});
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;

// The Manager woke the Lead to decide about a task: after a failed run (a failure wake-up),
// or while a run is still going (a watch check-in, `trigger` "watch"). `trigger`, `status`
// and `outcome` are strings so a later value does not break an older reader.
export const LeadInterventionSchema = z.object({
  id: IdSchema,
  // The task and run a failure wake-up or check-in is about: the failed run, or the run being
  // watched. Optional for a later kind of intervention about the whole goal.
  taskId: IdSchema.optional(),
  runId: IdSchema.optional(),
  // "attempts_exhausted", "lead_stopped", "timeout", "repeated_failure" or "watch".
  trigger: z.string(),
  // The failed run's error; empty for a check-in.
  error: z.string(),
  // What fired a check-in: "near_timeout", "stall".
  triggers: z.array(z.string()).optional(),
  // A check-in's number within its run, from 1.
  checkIn: z.number().int().positive().optional(),
  // Diff stat and status of the run's worktree, capped.
  workSummary: z.string().optional(),
  // "open", "awaiting_approval" (a revision answering it is pending), "resolved" or "abandoned".
  status: z.string(),
  // Failure wake-ups: "revised", "continue", "give_up", "revision_rejected".
  // Check-ins: "ok", "nudged", "stopped", "run_ended". Both: "expired", "lead_unavailable",
  // "superseded".
  outcome: z.string().optional(),
  note: z.string().optional(),
  // What the Lead sent the worker, for outcome "nudged".
  message: z.string().optional(),
  revisionId: IdSchema.optional(),
  requestedAt: z.string(),
  resolvedAt: z.string().optional(),
  // `reopens` of the goal when it was requested; the caps count only the current one.
  // Absent means 0.
  epoch: z.number().int().nonnegative().optional(),
});
export type LeadIntervention = z.infer<typeof LeadInterventionSchema>;

// How the Lead, or the Manager without it, decided to recover a failed goal. `decision` is
// "retry", "revise" or "needs_person", a string so a later value does not break an older
// reader. `hints` is advice for the workers of failed or cancelled tasks, by task id; `ops`
// is the plan change of a revise. `fallback` marks a decision the Manager took without the
// Lead's answer.
export const RecoveryDecisionSchema = z.object({
  decision: z.string(),
  reason: z.string(),
  hints: z.record(z.string(), z.string()).optional(),
  ops: z.array(PlanRevisionOpSchema).optional(),
  fallback: z.boolean().optional(),
});
export type RecoveryDecision = z.infer<typeof RecoveryDecisionSchema>;

// The latest recovery of a failed goal. The goal stays failed while the Lead decides.
// `status` is "deciding", "decided" (being applied), "awaiting_approval" (a revise waits for a
// person), "applied" (the goal was reopened) or "ended"; `outcome` is "applied", "rejected",
// "needs_person" or "cancelled". Both are strings so a later value does not break an older reader.
export const RecoverySchema = z.object({
  id: IdSchema,
  status: z.string(),
  startedAt: z.string(),
  startedBy: z.string(),
  // What the goal failed with, and when, as the recovery started. A recovery that ends without
  // applying rewrites the goal's reason and failure time; these keep the originals.
  failureReason: z.string(),
  failedAt: z.string().optional(),
  // The time mode and active time the restart of the time limit uses when it is applied.
  timeMode: z.string().optional(),
  activeMs: z.number().int().nonnegative().optional(),
  leadAgentId: z.string().optional(),
  leadWorkspaceId: z.string().optional(),
  interventionId: IdSchema.optional(),
  decision: RecoveryDecisionSchema.optional(),
  decidedAt: z.string().optional(),
  // True once the recovery counts toward the goal's recovery limit: the Lead decided.
  counted: z.boolean().optional(),
  outcome: z.string().optional(),
  reason: z.string().optional(),
  resolvedAt: z.string().optional(),
});
export type Recovery = z.infer<typeof RecoverySchema>;

// Instructions for the goal's workers. `goal` and `tasks` (by task id) are a person's and are
// authoritative. `lead` is the Lead's advice from recovery `recoveryId`; the next recovery
// replaces it.
export const GuidanceSchema = z.object({
  goal: z.string().optional(),
  tasks: z.record(z.string(), z.string()).optional(),
  lead: z.object({ recoveryId: IdSchema, tasks: z.record(z.string(), z.string()) }).optional(),
  // Set in goal.list, mutation responses and goal.update when a text was cut short there;
  // goal.inspect carries it in full.
  truncated: z.boolean().optional(),
});
export type Guidance = z.infer<typeof GuidanceSchema>;

// A person's change to the guidance, merged into the goal's: a string sets an entry, null
// clears it, absent leaves it.
export const GuidanceChangesSchema = z.object({
  goal: z.string().nullable().optional(),
  tasks: z.record(z.string(), z.string().nullable()).optional(),
});
export type GuidanceChanges = z.infer<typeof GuidanceChangesSchema>;

// Agents of the goal waiting for a person to answer a permission request or a question, keyed
// by agent id, and the waiting time the goal's time limit leaves out (see ./time-limit.ts).
// `since` is when the current stretch of waiting began, null while no agent waits; overlapping
// waits count once. `excludedMs` counts from the time base and is cleared when it moves.
export const GoalWaitsSchema = z.object({
  open: z.record(z.string(), z.object({ since: z.string(), runId: IdSchema.optional() })),
  excludedMs: z.number().nonnegative(),
  since: z.string().nullable(),
});
export type GoalWaits = z.infer<typeof GoalWaitsSchema>;

export const GoalSchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1),
  objective: z.string(),
  status: GoalStatusSchema,
  // Null for a manual goal: the Manager does not plan or run anything for it.
  config: GoalConfigSchema.nullable(),
  leadAgentId: z.string().nullable(),
  leadWorkspaceId: z.string().nullable(),
  criteria: z.array(AcceptanceCriterionSchema),
  tasks: z.array(TaskSchema),
  runs: z.array(AgentRunSchema),
  changeSets: z.array(ChangeSetSchema),
  integration: IntegrationSchema.nullable(),
  // Absent from daemons that predate recorded notifications.
  notifications: z.array(NotificationSchema).optional(),
  // When the goal was paused; null or absent while it runs. A paused goal starts no worker runs.
  pausedAt: z.string().nullable().optional(),
  // Plans sent back to the Lead, oldest first. Absent from daemons without goal controls.
  planRejections: z.array(PlanRejectionSchema).optional(),
  // Plan revisions after approval, oldest first. Absent until the first one is proposed.
  // goal.list, mutation responses and goal.update send decided revisions with `ops: []`
  // (left out, not "changed nothing"); goal.inspect sends every revision in full.
  planRevisions: z.array(PlanRevisionSchema).optional(),
  // Times the Lead was woken to decide about a task, oldest first. Absent until the first one.
  interventions: z.array(LeadInterventionSchema).optional(),
  // Times a failed goal was reopened by a retry.
  reopens: z.number().int().nonnegative().optional(),
  // Where goalTimeoutMinutes counts from, set by a retry that chose a time mode; read absent
  // as createdAt. Absent from daemons without server_info.features.goalTimeBase.
  timeBaseAt: z.string().optional(),
  // Waiting for a person's answer. Absent until an agent first waited, and from daemons without
  // server_info.features.goalUserWait.
  waits: GoalWaitsSchema.optional(),
  // The latest recovery, how many recoveries counted toward the limit, when the goal last
  // failed, and the guidance its workers get. Absent until first set, and from daemons
  // without server_info.features.goalRecovery.
  recovery: RecoverySchema.optional(),
  recoveries: z.number().int().nonnegative().optional(),
  failedAt: z.string().optional(),
  guidance: GuidanceSchema.optional(),
  // Usage of every agent turn: Lead, workers, reviewers, verifier. Absent until the
  // first turn is recorded, and from daemons that predate usage tracking.
  usage: UsageTotalsSchema.optional(),
  // Usage per role and per agent; their sums equal `usage`. Absent until the first turn is
  // recorded, from daemons before v0.13.3, and for clients without the goal_usage_breakdown
  // capability. The breakdown keeps the agents most recently active; `usageBreakdownTruncated`
  // counts the ones dropped, whose usage still counts in `usage` and `usageByRole`.
  usageByRole: UsageByRoleSchema.optional(),
  usageBreakdown: z.array(UsageBreakdownEntrySchema).optional(),
  usageBreakdownTruncated: z.number().int().nonnegative().optional(),
  // When every task succeeded and every change set settled, so verification could start.
  // Absent until then, and from daemons that predate stage times.
  verifyStartedAt: z.string().optional(),
  // When the last acceptance criterion was verified.
  verifiedAt: z.string().optional(),
  // How many times an applied recovery that added or replaced tasks started verification over,
  // clearing every criterion. Absent until the first time, and from daemons without
  // server_info.features.goalVerificationRecovery.
  verificationRound: z.number().int().positive().optional(),
  // Set when a person accepted the failed goal as is, completing it with its unverified
  // criteria waived. Absent otherwise, from daemons without server_info.features.goalAccept,
  // and for clients without the goal_accept capability.
  accepted: GoalAcceptanceSchema.optional(),
  // When a person dismissed an ended goal. Null again after a retry reopens it. It changes
  // nothing else. Absent from daemons without goal.acknowledge.
  acknowledgedAt: z.string().nullable().optional(),
  // Absent from daemons without goal management; read absent as "normal".
  priority: GoalPrioritySchema.optional(),
  // When a person archived the ended goal; null after unarchiving. goal.list hides archived
  // goals unless asked. Absent from daemons without goal management.
  archivedAt: z.string().nullable().optional(),
  // Sequence number of the last event folded into this state.
  lastSeq: z.number().int().nonnegative(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Goal = z.infer<typeof GoalSchema>;

// Task counts for a list row; see summarizeGoalProgress in ./progress.ts.
export const GoalProgressSummarySchema = z.object({
  tasksTotal: z.number().int().nonnegative(),
  tasksDone: z.number().int().nonnegative(),
  tasksFailed: z.number().int().nonnegative(),
  tasksRunning: z.number().int().nonnegative(),
});
export type GoalProgressSummary = z.infer<typeof GoalProgressSummarySchema>;

// A goal as goal.list and goal.update carry it: the full goal plus derived counts.
// `progress` is absent from daemons that predate it; derive it from `tasks` then.
export const GoalSummarySchema = GoalSchema.extend({
  progress: GoalProgressSummarySchema.optional(),
});
export type GoalSummary = z.infer<typeof GoalSummarySchema>;

const eventEnvelope = {
  // Unique per event; the log treats a repeated id as a duplicate delivery.
  id: IdSchema,
  goalId: IdSchema,
  // Assigned by the log, strictly increasing per goal starting at 1.
  seq: z.number().int().positive(),
  at: z.string(),
};

/**
 * How a retry restarts the goal's time limit. `fresh` counts goalTimeoutMinutes from the
 * retry; `remaining` keeps the time the goal spent running since it was created or last
 * restarted fresh, leaving out the time it sat paused or failed.
 */
export const GOAL_TIME_MODES = ["fresh", "remaining"] as const;
export type GoalTimeMode = (typeof GOAL_TIME_MODES)[number];

/**
 * How a wait for a person's answer ended: answered (or withdrawn), past
 * `limits.userWaitMinutes`, or its turn ended another way (cancelled, a restart).
 */
export const WAIT_OUTCOMES = ["answered", "expired", "turn_ended"] as const;
export type WaitOutcome = (typeof WAIT_OUTCOMES)[number];

/** Part of the refusal of a retry whose time limit has passed and that chose no time mode. */
export const GOAL_TIME_LIMIT_PASSED = "the goal's time limit has passed";

// Fields of the events that put a goal back to work (goal.retried, goal.reopened,
// changeset.integration_retried). `timeMode` is one of GOAL_TIME_MODES, a string so the set
// can grow; the reducer refuses others. `activeMs` is the time the goal ran, recorded with
// `remaining` so a replay does not recompute it. Absent: the time limit counts as before.
const retryTimeFields = {
  timeMode: z.string().optional(),
  activeMs: z.number().int().nonnegative().optional(),
};

export const GoalEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventEnvelope,
    type: z.literal("goal.created"),
    title: z.string().trim().min(1),
    objective: z.string(),
    criteria: z.array(z.object({ id: IdSchema, text: z.string().trim().min(1) })),
    config: GoalConfigSchema.nullable().optional(),
    // Absent means "normal".
    priority: GoalPrioritySchema.optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("lead.attached"),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1).optional(),
  }),
  // Written before notifications were recorded: the Lead was told something, outcome unknown.
  // Current daemons write notification.queued instead, under the same event id.
  z.object({ ...eventEnvelope, type: z.literal("lead.notified"), key: z.string().min(1) }),
  // A notification is due. Accepted after the goal has ended, so its outcome can be sent.
  z.object({
    ...eventEnvelope,
    type: z.literal("notification.queued"),
    key: z.string().min(1),
    target: NotificationTargetSchema,
    text: z.string(),
  }),
  // One delivery attempt and how it ended.
  z.object({
    ...eventEnvelope,
    type: z.literal("notification.attempted"),
    key: z.string().min(1),
    target: NotificationTargetSchema,
    attempt: z.number().int().min(1),
    outcome: z.enum(["delivered", "failed"]),
    error: z.string().optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("plan.proposed"),
    tasks: z.array(TaskSpecSchema),
  }),
  z.object({ ...eventEnvelope, type: z.literal("plan.approved") }),
  // `reason` is the person's feedback for the Lead; it may be empty.
  z.object({ ...eventEnvelope, type: z.literal("plan.rejected"), reason: z.string() }),
  z.object({ ...eventEnvelope, type: z.literal("task.started"), taskId: IdSchema }),
  z.object({
    ...eventEnvelope,
    type: z.literal("task.succeeded"),
    taskId: IdSchema,
    summary: z.string().optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("run.started"),
    runId: IdSchema,
    taskId: IdSchema,
    provider: AgentProviderSchema,
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("run.attached"),
    runId: IdSchema,
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    cwd: z.string().min(1).optional(),
    // The agent's thinking option once created.
    thinking: z.string().min(1).optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("run.finished"),
    runId: IdSchema,
    outcome: z.enum(["succeeded", "failed", "interrupted"]),
    error: z.string().optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("task.failed"),
    taskId: IdSchema,
    error: z.string(),
  }),
  // Returns a failed or running task to pending so it can be dispatched again.
  z.object({ ...eventEnvelope, type: z.literal("task.retried"), taskId: IdSchema }),
  z.object({ ...eventEnvelope, type: z.literal("task.cancelled"), taskId: IdSchema }),
  z.object({
    ...eventEnvelope,
    type: z.literal("criterion.verified"),
    criterionId: IdSchema,
    evidence: z.string().optional(),
    // The goal's verificationRound when the verifier was asked (0 before any). A result for
    // another round is refused. Absent from logs written before v0.13.14.
    round: z.number().int().nonnegative().optional(),
  }),
  // The Manager adds a rework task to fix a change set.
  z.object({
    ...eventEnvelope,
    type: z.literal("task.added"),
    task: TaskSpecSchema,
    rework: ReworkSchema,
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("integration.prepared"),
    branch: z.string(),
    workspaceId: z.string(),
    cwd: z.string(),
    baseCommit: z.string(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("changeset.captured"),
    changeSetId: IdSchema,
    taskId: IdSchema,
    runId: IdSchema,
    round: z.number().int().nonnegative(),
    supersedes: z.string().nullable(),
    workspaceId: z.string(),
    cwd: z.string(),
    branch: z.string(),
    baseCommit: z.string(),
    headCommit: z.string(),
    files: z.array(ChangedFileSchema),
  }),
  // An implement task finished without changing anything, so there is nothing to review.
  z.object({
    ...eventEnvelope,
    type: z.literal("capture.skipped"),
    taskId: IdSchema,
    runId: IdSchema,
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("changeset.transitioned"),
    changeSetId: IdSchema,
    to: ChangeSetStatusSchema,
    findings: z.string().optional(),
    testSummary: z.string().optional(),
    integratedCommit: z.string().optional(),
    error: z.string().optional(),
    // Why a change set moved to rejected; CHANGE_SET_INTEGRATION_FAILED when the merge step
    // failed. A string, not an enum, so a later reason does not break an older reader.
    // Absent from daemons before v0.13.10.
    reason: z.string().optional(),
  }),
  // A person retried the merge of change sets whose integration failed, reopening the
  // failed goal. Each goes from rejected back to approved and is merged again; its review
  // and approval stand. `taskIds` are the failed and cancelled tasks retried with it, as in
  // a reopening goal.retried. Accepted only on a failed goal.
  z.object({
    ...eventEnvelope,
    type: z.literal("changeset.integration_retried"),
    changeSetIds: z.array(IdSchema).min(1),
    taskIds: z.array(IdSchema),
    ...retryTimeFields,
    // Change sets whose rework failed, reopened with it (see goal.retried). Absent from
    // daemons before v0.13.14.
    reworkChangeSetIds: z.array(IdSchema).optional(),
  }),
  // An agent of the goal waits for a person to answer a permission request or a question, and
  // stops waiting: `outcome` is one of WAIT_OUTCOMES. Waiting time does not count toward the
  // run or goal time limit. Absent from daemons without server_info.features.goalUserWait, and
  // from goal.inspect for clients without the goal_user_wait capability.
  z.object({
    ...eventEnvelope,
    type: z.literal("wait.started"),
    agentId: z.string().min(1),
    role: UsageRoleSchema,
    runId: IdSchema.optional(),
    request: z
      .object({ kind: z.string(), tool: z.string(), text: z.string().optional() })
      .optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("wait.ended"),
    agentId: z.string().min(1),
    outcome: z.string(),
  }),
  z.object({ ...eventEnvelope, type: z.literal("goal.completed") }),
  z.object({ ...eventEnvelope, type: z.literal("goal.failed"), reason: z.string() }),
  z.object({ ...eventEnvelope, type: z.literal("goal.cancelled") }),
  // A person accepted a failed goal as is: it completes with `criterionIds`, every criterion
  // still unverified, waived. `acceptedFrom` is the failure reason at that moment; `client` is
  // "app" or "cli". Absent from daemons without server_info.features.goalAccept.
  z.object({
    ...eventEnvelope,
    type: z.literal("goal.accepted"),
    criterionIds: z.array(IdSchema),
    note: z.string(),
    acceptedFrom: z.string(),
    client: z.string(),
  }),
  // One agent turn ended. `usage` is what the provider reported, absent when it reported
  // nothing. `runId` is set for a worker run's turn, `changeSetId` for a reviewer's.
  // `thinking` is the agent's thinking option; absent from daemons before v0.13.3.
  z.object({
    ...eventEnvelope,
    type: z.literal("usage.recorded"),
    role: UsageRoleSchema,
    agentId: z.string().min(1),
    runId: IdSchema.optional(),
    changeSetId: IdSchema.optional(),
    thinking: z.string().min(1).optional(),
    usage: TurnUsageSchema.optional(),
  }),
  // A person stops new worker runs from starting, then lets them start again.
  z.object({ ...eventEnvelope, type: z.literal("goal.paused") }),
  z.object({ ...eventEnvelope, type: z.literal("goal.resumed") }),
  // A person retries failed or cancelled tasks. `reopen` is set when the goal had
  // failed and goes back to executing; it then covers every failed and cancelled task.
  z.object({
    ...eventEnvelope,
    type: z.literal("goal.retried"),
    taskIds: z.array(IdSchema).min(1),
    reopen: z.boolean(),
    ...retryTimeFields,
    // A person's change to the workers' guidance. Absent from daemons without goalRecovery.
    guidance: GuidanceChangesSchema.optional(),
    // Change sets rejected because their rework failed (CHANGE_SET_REWORK_FAILED), reopened:
    // each goes back to the status it was rejected from and its rework task runs again. A
    // reopen lists every such change set. Absent from daemons before v0.13.14.
    reworkChangeSetIds: z.array(IdSchema).optional(),
  }),
  // A person dismissed an ended goal. Accepted only after the goal has ended.
  z.object({ ...eventEnvelope, type: z.literal("goal.acknowledged") }),
  // Goal management. Accepted in any state, ended goals included.
  z.object({ ...eventEnvelope, type: z.literal("goal.renamed"), title: z.string().trim().min(1) }),
  z.object({
    ...eventEnvelope,
    type: z.literal("goal.priority_set"),
    priority: GoalPrioritySchema,
  }),
  // Accepted only after the goal has ended.
  z.object({ ...eventEnvelope, type: z.literal("goal.archived") }),
  z.object({ ...eventEnvelope, type: z.literal("goal.unarchived") }),
  // A person changed the goal's settings; `config` is the whole config from now on. Accepted
  // in any state but archived, ended goals included. Only the fields GoalConfigChanges
  // lists may differ from the current config.
  z.object({ ...eventEnvelope, type: z.literal("goal.config_updated"), config: GoalConfigSchema }),
  // A person reopened a goal that failed while planning (it has no tasks); a fresh Lead
  // plans again. A goal that failed later is reopened by goal.retried instead.
  z.object({ ...eventEnvelope, type: z.literal("goal.reopened"), ...retryTimeFields }),
  // The Lead or a person proposes a change to an executing goal's plan. `interventionId`
  // is set when it answers a Lead intervention.
  z.object({
    ...eventEnvelope,
    type: z.literal("plan.revision_proposed"),
    revisionId: IdSchema,
    source: z.string(),
    reason: z.string(),
    ops: z.array(PlanRevisionOpSchema).min(1),
    interventionId: IdSchema.optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("plan.revision_approved"),
    revisionId: IdSchema,
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("plan.revision_rejected"),
    revisionId: IdSchema,
    reason: z.string(),
  }),
  // The Manager woke the Lead about a task; see LeadInterventionSchema for the fields.
  z.object({
    ...eventEnvelope,
    type: z.literal("intervention.requested"),
    interventionId: IdSchema,
    taskId: IdSchema.optional(),
    runId: IdSchema.optional(),
    trigger: z.string(),
    error: z.string(),
    triggers: z.array(z.string()).optional(),
    checkIn: z.number().int().positive().optional(),
    workSummary: z.string().optional(),
  }),
  // The Lead decided, or the Manager stopped waiting. Outcomes the reducer sets itself
  // (revised, revision_rejected, superseded, run_ended) never come from this event.
  z.object({
    ...eventEnvelope,
    type: z.literal("intervention.resolved"),
    interventionId: IdSchema,
    outcome: z.string(),
    note: z.string().optional(),
    message: z.string().optional(),
  }),
  // A person asked the Lead to recover the failed goal. `timeMode` and `activeMs` are used when
  // the recovery is applied; see retryTimeFields.
  z.object({
    ...eventEnvelope,
    type: z.literal("recovery.started"),
    recoveryId: IdSchema,
    startedBy: z.string(),
    ...retryTimeFields,
    guidance: GuidanceChangesSchema.optional(),
  }),
  // The Lead decided, or the Manager decided without it (`decision.fallback`).
  z.object({
    ...eventEnvelope,
    type: z.literal("recovery.decided"),
    recoveryId: IdSchema,
    decision: RecoveryDecisionSchema,
  }),
  // The recovery ended. `outcome` "applied" reopens the goal, restarting its time limit with
  // the recovery's `timeMode` and `activeMs`, copied here; "rejected", "needs_person" and
  // "cancelled" leave it failed. `uncounted` keeps a Lead-decided recovery that ended before it
  // could apply (the integration check failed) from counting toward the limit.
  z.object({
    ...eventEnvelope,
    type: z.literal("recovery.resolved"),
    recoveryId: IdSchema,
    outcome: z.string(),
    reason: z.string().optional(),
    ...retryTimeFields,
    uncounted: z.boolean().optional(),
    // On "applied": change sets whose rework failed, reopened as on goal.retried. Absent from
    // daemons before v0.13.14.
    reworkChangeSetIds: z.array(IdSchema).optional(),
  }),
]);
export type GoalEvent = z.infer<typeof GoalEventSchema>;
export type GoalEventType = GoalEvent["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a caller supplies; the log fills in `seq` and `at`. */
export type GoalEventInput = DistributiveOmit<GoalEvent, "seq" | "at">;
