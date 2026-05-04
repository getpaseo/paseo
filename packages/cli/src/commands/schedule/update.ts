import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  createScheduleInspectRows,
  createScheduleInspectSchema,
  type ScheduleInspectRow,
} from "./schema.js";
import {
  connectScheduleClient,
  parseScheduleUpdateInput,
  toScheduleCommandError,
  type ScheduleCommandOptions,
} from "./shared.js";

export interface ScheduleUpdateOptions extends ScheduleCommandOptions {
  every?: string;
  cron?: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  maxRuns?: string;
  noMaxRuns?: boolean;
  expiresIn?: string;
  noExpiresIn?: boolean;
}

export async function runUpdateCommand(
  id: string,
  options: ScheduleUpdateOptions,
  _command: Command,
): Promise<ListResult<ScheduleInspectRow>> {
  const input = parseScheduleUpdateInput({
    id,
    every: options.every,
    cron: options.cron,
    name: options.name,
    prompt: options.prompt,
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    cwd: options.cwd,
    maxRuns: options.maxRuns,
    expiresIn: options.expiresIn,
    clearMaxRuns: options.noMaxRuns,
    clearExpires: options.noExpiresIn,
  });
  const { client } = await connectScheduleClient(options.host);
  try {
    const payload = await client.scheduleUpdate(input);
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? `Failed to update schedule: ${id}`);
    }
    return {
      type: "list",
      data: createScheduleInspectRows(payload.schedule),
      schema: createScheduleInspectSchema(payload.schedule),
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_UPDATE_FAILED", "update schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
