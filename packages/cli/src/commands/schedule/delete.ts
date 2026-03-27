import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import type { OutputSchema } from "../../output/index.js";
import { connectScheduleClient, toScheduleCommandError, type ScheduleCommandOptions } from "./shared.js";

interface ScheduleDeleteRow {
  id: string;
  status: string;
}

const scheduleDeleteSchema: OutputSchema<ScheduleDeleteRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "STATUS", field: "status", width: 12 },
  ],
};

export async function runDeleteCommand(
  id: string,
  options: ScheduleCommandOptions,
  _command: Command,
): Promise<SingleResult<ScheduleDeleteRow>> {
  const { client } = await connectScheduleClient(options.host);
  try {
    const payload = await client.scheduleDelete({ id });
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "single",
      data: {
        id: payload.scheduleId,
        status: "deleted",
      },
      schema: scheduleDeleteSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_DELETE_FAILED", "delete schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
