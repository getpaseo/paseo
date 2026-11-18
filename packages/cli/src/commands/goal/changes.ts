import type { Command } from "commander";
import { CHANGE_SET_REWORK_FAILED, type ChangeSet } from "@getpaseo/protocol/goal/types";
import type { ListResult, OutputSchema } from "../../output/index.js";
import { connectGoalClient, toGoalCommandError, type GoalCommandOptions } from "./shared.js";

interface ChangeSetRow {
  id: string;
  task: string;
  round: number;
  status: string;
  commits: string;
  files: number;
}

const changeSetSchema: OutputSchema<ChangeSetRow> = {
  idField: "id",
  columns: [
    { header: "CHANGE SET", field: "id", width: 24 },
    { header: "TASK", field: "task", width: 12 },
    { header: "ROUND", field: "round", width: 6 },
    { header: "STATUS", field: "status", width: 18 },
    { header: "BASE..HEAD", field: "commits", width: 18 },
    { header: "FILES", field: "files", width: 6 },
  ],
};

/** A change set whose rework failed says so, since a retry reworks it again. */
function changeSetStatusLabel(changeSet: Pick<ChangeSet, "status" | "rejectionReason">): string {
  return changeSet.status === "rejected" && changeSet.rejectionReason === CHANGE_SET_REWORK_FAILED
    ? "rejected (rework failed)"
    : changeSet.status;
}

export async function runChangesCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<ListResult<ChangeSetRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const payload = await client.goalInspect(id);
    if (payload.error || !payload.goal) {
      throw new Error(payload.error ?? `Goal not found: ${id}`);
    }
    const { changeSets, integration } = payload.goal;
    return {
      type: "list",
      data: changeSets.map((c) => ({
        id: c.id,
        task: c.taskId,
        round: c.round,
        status: changeSetStatusLabel(c),
        commits: `${c.baseCommit.slice(0, 7)}..${c.headCommit.slice(0, 7)}`,
        files: c.files.length,
      })),
      schema: {
        ...changeSetSchema,
        // JSON output carries full change sets and the integration branch.
        serialize: (row) => ({ ...changeSets.find((c) => c.id === row.id), integration }),
      },
    };
  } catch (error) {
    throw toGoalCommandError("GOAL_CHANGES_FAILED", "list change sets", error);
  } finally {
    await client.close().catch(() => {});
  }
}
