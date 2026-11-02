import type { Command } from "commander";
import { GoalPermissionPolicySchema, type GoalConfigChanges } from "@getpaseo/protocol/goal/types";
import type { SingleResult } from "../../output/index.js";
import { parseEnum } from "./ls.js";
import {
  connectGoalClient,
  goalSchema,
  toGoalCommandError,
  toGoalRow,
  type GoalCommandOptions,
  type GoalRow,
} from "./shared.js";

/** The value that clears an optional setting: its default applies, or the cap is removed. */
const CLEAR = "none";

export interface GoalConfigOptions extends GoalCommandOptions {
  onPermission?: string;
  notifyLead?: boolean;
  leadInterventions?: boolean;
  autoApprove?: boolean;
  requireApproval?: boolean;
  testCommand?: string;
  maxParallel?: string;
  maxAttempts?: string;
  maxRework?: string;
  maxTasks?: string;
  maxRuns?: string;
  runTimeout?: string;
  goalTimeout?: string;
  userWait?: string;
  retryBackoff?: string;
  maxTokens?: string;
  maxCost?: string;
  deadline?: string;
}

function parseNumber(value: string, name: string, integer: boolean): number {
  const parsed = integer ? Number.parseInt(value, 10) : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number or ${CLEAR}`);
  return parsed;
}

/** A number, null for `none`, or undefined when the flag was not given. */
function numberChange(
  value: string | undefined,
  name: string,
  integer = true,
): number | null | undefined {
  if (value === undefined) return undefined;
  return value === CLEAR ? null : parseNumber(value, name, integer);
}

/** A string, null for `none`, or undefined when the flag was not given. */
function textChange(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === CLEAR ? null : value;
}

/** A setting that must have a value: `none` is refused. */
function requiredNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (value === CLEAR) throw new Error(`${name} cannot be cleared`);
  return parseNumber(value, name, true);
}

function defined<T extends object>(entries: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** The changes the flags ask for; flags left out keep their setting. */
export function buildConfigChanges(options: GoalConfigOptions): GoalConfigChanges {
  const limits = defined({
    maxTasks: numberChange(options.maxTasks, "--max-tasks"),
    maxRuns: numberChange(options.maxRuns, "--max-runs"),
    runTimeoutMinutes: numberChange(options.runTimeout, "--run-timeout"),
    goalTimeoutMinutes: numberChange(options.goalTimeout, "--goal-timeout"),
    userWaitMinutes: numberChange(options.userWait, "--user-wait"),
    retryBackoffSeconds: numberChange(options.retryBackoff, "--retry-backoff"),
    maxTotalTokens: numberChange(options.maxTokens, "--max-tokens"),
    maxCostUsd: numberChange(options.maxCost, "--max-cost", false),
    deadlineAt: textChange(options.deadline),
  });
  const changes: GoalConfigChanges = defined({
    onPermissionRequest:
      options.onPermission === undefined
        ? undefined
        : parseEnum(GoalPermissionPolicySchema, options.onPermission, "--on-permission"),
    notifyLead: options.notifyLead,
    leadInterventions: options.leadInterventions,
    autoApprovePlan: options.autoApprove,
    requireHumanApproval: options.requireApproval,
    testCommand: textChange(options.testCommand),
    maxParallel: requiredNumber(options.maxParallel, "--max-parallel"),
    maxAttempts: requiredNumber(options.maxAttempts, "--max-attempts"),
    maxReworkRounds: numberChange(options.maxRework, "--max-rework"),
  });
  if (Object.keys(limits).length > 0) changes.limits = limits;
  if (Object.keys(changes).length === 0) {
    throw new Error("Name at least one setting to change, e.g. --on-permission wait");
  }
  return changes;
}

export async function runConfigCommand(
  id: string,
  options: GoalConfigOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const payload = await client.goalUpdateConfig({
      goalId: id,
      changes: buildConfigChanges(options),
    });
    if (payload.error || !payload.goal) {
      throw new Error(payload.error ?? "Daemon returned no goal");
    }
    return { type: "single", data: toGoalRow(payload.goal), schema: goalSchema };
  } catch (error) {
    throw toGoalCommandError("GOAL_CONFIG_FAILED", "change goal settings", error);
  } finally {
    await client.close().catch(() => {});
  }
}
