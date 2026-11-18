import path from "node:path";
import type { Command } from "commander";
import {
  GoalListArchivedFilterSchema,
  type GoalListArchivedFilter,
} from "@getpaseo/protocol/goal/rpc-schemas";
import {
  GoalPrioritySchema,
  GoalStatusSchema,
  type GoalPriority,
  type GoalStatus,
} from "@getpaseo/protocol/goal/types";
import type { ListResult } from "../../output/index.js";
import {
  connectGoalClient,
  goalSchema,
  toGoalCommandError,
  toGoalRow,
  type GoalCommandOptions,
  type GoalRow,
} from "./shared.js";

export interface GoalLsOptions extends GoalCommandOptions {
  search?: string;
  status?: string[];
  priority?: string[];
  archived?: string;
  project?: string;
}

export interface GoalListFilter {
  query?: string;
  status?: GoalStatus[];
  priority?: GoalPriority[];
  archived?: GoalListArchivedFilter;
  cwd?: string;
}

/** Turn `goal ls` flags into goal.list filters. Throws on a value the daemon would reject. */
export function parseGoalListFilter(options: GoalLsOptions): GoalListFilter {
  const filter: GoalListFilter = {};
  if (options.search !== undefined) filter.query = options.search;
  if (options.status?.length) {
    filter.status = options.status.map((value) => parseEnum(GoalStatusSchema, value, "--status"));
  }
  if (options.priority?.length) {
    filter.priority = options.priority.map((value) =>
      parseEnum(GoalPrioritySchema, value, "--priority"),
    );
  }
  if (options.archived !== undefined) {
    filter.archived = parseEnum(GoalListArchivedFilterSchema, options.archived, "--archived");
  }
  // Goals record their repository as an absolute path.
  if (options.project !== undefined) filter.cwd = path.resolve(options.project);
  return filter;
}

export function parseEnum<T extends string>(
  schema: { options: readonly T[] },
  value: string,
  flag: string,
): T {
  const match = schema.options.find((option) => option === value.trim());
  if (!match) throw new Error(`${flag} must be one of ${schema.options.join(", ")}`);
  return match;
}

export async function runLsCommand(
  options: GoalLsOptions,
  _command: Command,
): Promise<ListResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const filter = parseGoalListFilter(options);
    const payload = await client.goalList(Object.keys(filter).length > 0 ? filter : undefined);
    if (payload.error) {
      throw new Error(payload.error);
    }
    return { type: "list", data: payload.goals.map(toGoalRow), schema: goalSchema };
  } catch (error) {
    throw toGoalCommandError("GOAL_LIST_FAILED", "list goals", error);
  } finally {
    await client.close().catch(() => {});
  }
}
