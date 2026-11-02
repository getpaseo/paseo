import path from "node:path";
import type { Command } from "commander";
import { GOAL_CONFIG_BOUNDS } from "@getpaseo/protocol/goal/config-bounds";
import {
  GoalPermissionPolicySchema,
  GoalPrioritySchema,
  type GoalConfig,
} from "@getpaseo/protocol/goal/types";
import { parseEnum } from "./ls.js";
import type { SingleResult } from "../../output/index.js";
import {
  connectGoalClient,
  goalSchema,
  toGoalCommandError,
  toGoalRow,
  type GoalCommandOptions,
  type GoalRow,
} from "./shared.js";

export interface GoalCreateOptions extends GoalCommandOptions {
  objective?: string;
  criterion?: string[];
  cwd?: string;
  lead?: string;
  provider?: string;
  maxParallel?: string;
  maxAttempts?: string;
  autoApprove?: boolean;
  notifyLead?: boolean;
  leadInterventions?: boolean;
  reviewProvider?: string;
  verifyProvider?: string;
  leadThinking?: string;
  workerThinking?: string;
  reviewThinking?: string;
  verifyThinking?: string;
  branchPrefix?: string;
  maxTokens?: string;
  maxCost?: string;
  deadline?: string;
  testCommand?: string;
  requireApproval?: boolean;
  maxRework?: string;
  maxTasks?: string;
  maxRuns?: string;
  runTimeout?: string;
  goalTimeout?: string;
  userWait?: string;
  retryBackoff?: string;
  onPermission?: string;
  allowProvider?: string[];
  priority?: string;
}

function intOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function buildLimits(options: GoalCreateOptions): GoalConfig["limits"] {
  const limits = {
    maxTasks: intOption(options.maxTasks, "--max-tasks"),
    maxRuns: intOption(options.maxRuns, "--max-runs"),
    runTimeoutMinutes: intOption(options.runTimeout, "--run-timeout"),
    goalTimeoutMinutes: intOption(options.goalTimeout, "--goal-timeout"),
    userWaitMinutes: intOption(options.userWait, "--user-wait"),
    retryBackoffSeconds: intOption(options.retryBackoff, "--retry-backoff"),
    maxTotalTokens: intOption(options.maxTokens, "--max-tokens"),
    maxCostUsd: numberOption(options.maxCost, "--max-cost"),
    deadlineAt: options.deadline,
  };
  const set = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined));
  return Object.keys(set).length > 0 ? set : undefined;
}

// A goal runs under the Manager only when --cwd is given; without it the goal is
// manual and only records plans and state.
function buildConfig(options: GoalCreateOptions): GoalConfig | undefined {
  if (!options.cwd) return undefined;
  if (!options.lead || !options.provider) {
    throw new Error("--lead and --provider are required with --cwd");
  }
  return {
    cwd: path.resolve(options.cwd),
    leadProvider: options.lead,
    defaultProvider: options.provider,
    maxParallel:
      intOption(options.maxParallel, "--max-parallel") ?? GOAL_CONFIG_BOUNDS.maxParallel.default,
    maxAttempts:
      intOption(options.maxAttempts, "--max-attempts") ?? GOAL_CONFIG_BOUNDS.maxAttempts.default,
    autoApprovePlan: options.autoApprove === true,
    notifyLead: options.notifyLead !== false,
    // Undefined is not sent, and the daemon turns it on for a new goal.
    leadInterventions: options.leadInterventions,
    ...(options.reviewProvider ? { reviewProvider: options.reviewProvider } : {}),
    ...(options.verifyProvider ? { verifyProvider: options.verifyProvider } : {}),
    ...(options.leadThinking ? { leadThinking: options.leadThinking } : {}),
    ...(options.workerThinking ? { workerThinking: options.workerThinking } : {}),
    ...(options.reviewThinking ? { reviewThinking: options.reviewThinking } : {}),
    ...(options.verifyThinking ? { verifyThinking: options.verifyThinking } : {}),
    ...(options.branchPrefix ? { branchPrefix: options.branchPrefix } : {}),
    ...(options.testCommand ? { testCommand: options.testCommand } : {}),
    ...(options.requireApproval ? { requireHumanApproval: true } : {}),
    ...(options.maxRework ? { maxReworkRounds: Number.parseInt(options.maxRework, 10) } : {}),
    ...(buildLimits(options) ? { limits: buildLimits(options) } : {}),
    ...(options.onPermission
      ? {
          onPermissionRequest: parseEnum(
            GoalPermissionPolicySchema,
            options.onPermission,
            "--on-permission",
          ),
        }
      : {}),
    ...(options.allowProvider?.length ? { allowedProviders: options.allowProvider } : {}),
  };
}

export async function runCreateCommand(
  title: string,
  options: GoalCreateOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const config = buildConfig(options);
    const priority =
      options.priority === undefined
        ? undefined
        : parseEnum(GoalPrioritySchema, options.priority, "--priority");
    const payload = await client.goalCreate({
      ...(priority ? { priority } : {}),
      title,
      objective: options.objective ?? "",
      criteria: options.criterion ?? [],
      ...(config ? { config } : {}),
    });
    if (payload.error || !payload.goal) {
      throw new Error(payload.error ?? "Daemon returned no goal");
    }
    return { type: "single", data: toGoalRow(payload.goal), schema: goalSchema };
  } catch (error) {
    throw toGoalCommandError("GOAL_CREATE_FAILED", "create goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}
