import {
  applyResourcePatch,
  isCommandError,
  parseResourcePatch,
  type ResourceOptions,
} from "../../utils/resource-options.js";
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
  requireNewAgentSchedule,
  toScheduleCommandError,
  type ScheduleCommandOptions,
} from "./shared.js";

export interface ScheduleUpdateOptions extends ScheduleCommandOptions, ResourceOptions {
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  maxRuns?: string | false;
  expiresIn?: string | false;
}

export async function runUpdateCommand(
  id: string,
  options: ScheduleUpdateOptions,
  _command: Command,
): Promise<ListResult<ScheduleInspectRow>> {
  const resourcePatch = parseResourcePatch(options);
  const input = parseScheduleUpdateInput({
    id,
    hasResourceChanges: resourcePatch !== undefined,
    every: options.every,
    cron: options.cron,
    timezone: options.timezone,
    name: options.name,
    prompt: options.prompt,
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    cwd: options.cwd,
    maxRuns: options.maxRuns === false ? undefined : options.maxRuns,
    expiresIn: options.expiresIn === false ? undefined : options.expiresIn,
    clearMaxRuns: options.maxRuns === false,
    clearExpires: options.expiresIn === false,
  });
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    const schedule = await requireNewAgentSchedule(client, id);
    if (resourcePatch) {
      input.newAgentConfig = {
        ...input.newAgentConfig,
        resources: applyResourcePatch(schedule.target.config.resources, resourcePatch),
      };
    }
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
    if (isCommandError(error)) {
      throw error;
    }
    throw toScheduleCommandError("SCHEDULE_UPDATE_FAILED", "update schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
