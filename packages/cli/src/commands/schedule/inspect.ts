import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  createScheduleInspectRows,
  createScheduleInspectSchema,
  type ScheduleInspectRow,
} from "./schema.js";
import { connectScheduleClient, toScheduleCommandError, type ScheduleCommandOptions } from "./shared.js";

export async function runInspectCommand(
  id: string,
  options: ScheduleCommandOptions,
  _command: Command,
): Promise<ListResult<ScheduleInspectRow>> {
  const { client } = await connectScheduleClient(options.host);
  try {
    const payload = await client.scheduleInspect({ id });
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? `Schedule not found: ${id}`);
    }
    const rows = createScheduleInspectRows(payload.schedule);
    return {
      type: "list",
      data: rows,
      schema: createScheduleInspectSchema(payload.schedule),
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_INSPECT_FAILED", "inspect schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
