import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import type { GoalRetainedResource } from "@getpaseo/protocol/goal/rpc-schemas";
import { GoalPrioritySchema } from "@getpaseo/protocol/goal/types";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { parseEnum } from "./ls.js";
import {
  connectGoalClient,
  goalSchema,
  toGoalCommandError,
  toGoalRow,
  type GoalCommandOptions,
  type GoalRow,
} from "./shared.js";

export async function runRenameCommand(
  id: string,
  title: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalRename({ goalId: id, title }));
  } catch (error) {
    throw toGoalCommandError("GOAL_RENAME_FAILED", "rename goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runPriorityCommand(
  id: string,
  priority: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const parsed = parseEnum(GoalPrioritySchema, priority, "priority");
    return toResult(await client.goalSetPriority({ goalId: id, priority: parsed }));
  } catch (error) {
    throw toGoalCommandError("GOAL_PRIORITY_FAILED", "set goal priority", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runArchiveCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalArchive({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_ARCHIVE_FAILED", "archive goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runUnarchiveCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalUnarchive({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_UNARCHIVE_FAILED", "unarchive goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export interface GoalDeleteOptions extends GoalCommandOptions {
  yes?: boolean;
}

export interface DeleteConfirmation {
  interactive: boolean;
  structured: boolean;
  confirm(message: string): Promise<boolean>;
}

/**
 * Delete cannot be undone, so it asks first. Without a terminal to ask on, or with
 * structured output, it needs --yes.
 */
export async function confirmGoalDelete(
  id: string,
  options: Pick<GoalDeleteOptions, "yes">,
  interaction: DeleteConfirmation,
): Promise<boolean> {
  if (options.yes) return true;
  if (interaction.structured || !interaction.interactive) {
    throw new Error("Confirmation required; rerun with --yes.");
  }
  return interaction.confirm(
    `Delete goal ${id} and its event history for good? Its branches are kept. [y/N] `,
  );
}

export interface GoalDeleteRow {
  id: string;
  /** False when there was no such goal. */
  deleted: boolean;
  retained: GoalRetainedResource[];
}

const goalDeleteSchema: OutputSchema<GoalDeleteRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 38 },
    { header: "DELETED", field: "deleted", width: 8 },
    { header: "LEFT IN PLACE", field: (row) => describeRetained(row.retained), width: 80 },
  ],
};

export function describeRetained(retained: readonly GoalRetainedResource[]): string {
  if (retained.length === 0) return "-";
  return retained.map((r) => `${r.kind} ${r.name} (${r.reason})`).join("; ");
}

export async function runDeleteCommand(
  id: string,
  options: GoalDeleteOptions,
  _command: Command,
): Promise<SingleResult<GoalDeleteRow>> {
  const confirmed = await confirmGoalDelete(id, options, {
    interactive: process.stdin.isTTY === true,
    structured:
      options.json === true ||
      ["json", "yaml"].includes(options.format?.trim().toLowerCase() ?? ""),
    confirm: async (message) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^(y|yes)$/i.test((await prompt.question(message)).trim());
      } catch {
        return false;
      } finally {
        prompt.close();
      }
    },
  }).catch((error: unknown) => {
    throw toGoalCommandError("GOAL_DELETE_FAILED", "delete goal", error);
  });
  if (!confirmed) {
    throw { code: "GOAL_DELETE_DECLINED", message: "Goal not deleted" };
  }
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const payload = await client.goalDelete({ goalId: id });
    if (payload.error) throw new Error(payload.error);
    return {
      type: "single",
      data: {
        id: payload.goalId,
        deleted: payload.deleted,
        retained: payload.retained,
      },
      schema: goalDeleteSchema,
    };
  } catch (error) {
    throw toGoalCommandError("GOAL_DELETE_FAILED", "delete goal", error);
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
