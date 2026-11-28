import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { scheduleSchema } from "./schema.js";
import {
  connectScheduleClient,
  toScheduleCommandError,
  toScheduleRow,
  type ScheduleCommandOptions,
  type ScheduleRow,
} from "./shared.js";

export async function runLsCommand(
  options: ScheduleCommandOptions & { all?: boolean },
  _command: Command,
): Promise<ListResult<ScheduleRow>> {
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    const payload = await client.scheduleList();
    if (payload.error) {
      throw new Error(payload.error);
    }
    const visible = options.all
      ? payload.schedules
      : payload.schedules.filter((schedule) => schedule.target.type === "new-agent");
    const hiddenCount = payload.schedules.length - visible.length;
    if (
      hiddenCount > 0 &&
      !options.json &&
      (!options.format || options.format === "table") &&
      !options.quiet
    ) {
      console.error(
        "Schedules targeting existing agents: " +
          hiddenCount +
          " hidden. Use --all to include them.",
      );
    }
    return {
      type: "list",
      data: visible.map(toScheduleRow),
      schema: scheduleSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_LIST_FAILED", "list schedules", error);
  } finally {
    await client.close().catch(() => {});
  }
}
