import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  createScheduleInspectRows,
  createScheduleInspectSchema,
  type ScheduleInspectRow,
} from "./schema.js";
import {
  connectScheduleClient,
  requireNewAgentSchedule,
  toScheduleCommandError,
  type ScheduleCommandOptions,
} from "./shared.js";

export async function runInspectCommand(
  id: string,
  options: ScheduleCommandOptions,
  _command: Command,
): Promise<ListResult<ScheduleInspectRow>> {
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    const schedule = await requireNewAgentSchedule(client, id);
    const rows = createScheduleInspectRows(schedule);
    return {
      type: "list",
      data: rows,
      schema: createScheduleInspectSchema(schedule),
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_INSPECT_FAILED", "inspect schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
