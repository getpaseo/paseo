import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { scheduleSchema } from "./schema.js";
import {
  connectScheduleClient,
  toScheduleCommandError,
  toScheduleRow,
  type ScheduleCommandOptions,
  type ScheduleRow,
} from "./shared.js";

export async function runPauseCommand(
  id: string,
  options: ScheduleCommandOptions,
  _command: Command,
): Promise<SingleResult<ScheduleRow>> {
  const { client } = await connectScheduleClient(options.host);
  try {
    const payload = await client.schedulePause({ id });
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? `Failed to pause schedule: ${id}`);
    }
    return {
      type: "single",
      data: toScheduleRow(payload.schedule),
      schema: scheduleSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_PAUSE_FAILED", "pause schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
