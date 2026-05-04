import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { scheduleSchema } from "./schema.js";
import {
  connectScheduleClient,
  parseScheduleCreateInput,
  toScheduleCommandError,
  toScheduleRow,
  type ScheduleCommandOptions,
  type ScheduleRow,
} from "./shared.js";

export interface ScheduleCreateOptions extends ScheduleCommandOptions {
  every?: string;
  cron?: string;
  name?: string;
  target?: string;
  provider?: string;
  mode?: string;
  cwd?: string;
  maxRuns?: string;
  expiresIn?: string;
  runNow?: boolean;
}

export async function runCreateCommand(
  prompt: string,
  options: ScheduleCreateOptions,
  command: Command,
): Promise<SingleResult<ScheduleRow>> {
  const runNowSource = command.getOptionValueSource("runNow");
  const runNow = runNowSource === "cli" ? Boolean(options.runNow) : undefined;
  const input = parseScheduleCreateInput({
    prompt,
    every: options.every,
    cron: options.cron,
    name: options.name,
    target: options.target,
    provider: options.provider,
    mode: options.mode,
    cwd: options.cwd,
    host: options.host,
    maxRuns: options.maxRuns,
    expiresIn: options.expiresIn,
    runNow,
  });
  const { client } = await connectScheduleClient(options.host);
  try {
    const payload = await client.scheduleCreate(input);
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? "Schedule creation failed");
    }
    return {
      type: "single",
      data: toScheduleRow(payload.schedule),
      schema: scheduleSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_CREATE_FAILED", "create schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
