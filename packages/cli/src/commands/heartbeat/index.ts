import { Command } from "commander";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { parseDuration } from "../../utils/duration.js";
import {
  connectScheduleClient,
  toScheduleCommandError,
  toScheduleRow,
  type ScheduleRow,
} from "../schedule/shared.js";
import { scheduleSchema } from "../schedule/schema.js";

interface HeartbeatOptions extends CommandOptions {
  cron?: string;
  timezone?: string;
  name?: string;
  maxRuns?: string;
  expiresIn?: string;
}

interface HeartbeatDeleteRow {
  id: string;
  status: "deleted";
}

const heartbeatDeleteSchema: OutputSchema<HeartbeatDeleteRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id" },
    { header: "STATUS", field: "status" },
  ],
};

function requireCallerAgentId(): string {
  const agentId = process.env.PASEO_AGENT_ID?.trim();
  if (!agentId) {
    throw new Error("Heartbeat commands must run inside a Paseo agent");
  }
  return agentId;
}

async function requireOwnedHeartbeat(
  client: Awaited<ReturnType<typeof connectScheduleClient>>["client"],
  id: string,
  agentId: string,
): Promise<void> {
  const payload = await client.scheduleInspect({ id });
  if (payload.error || !payload.schedule) {
    throw new Error(payload.error ?? `Heartbeat not found: ${id}`);
  }
  if (payload.schedule.target.type !== "agent" || payload.schedule.target.agentId !== agentId) {
    throw new Error(`Heartbeat ${id} does not belong to agent ${agentId}`);
  }
}

async function runCreateHeartbeat(
  prompt: string,
  options: HeartbeatOptions,
  _command: Command,
): Promise<SingleResult<ScheduleRow>> {
  const agentId = requireCallerAgentId();
  const cron = options.cron?.trim();
  if (!cron) {
    throw new Error("--cron is required");
  }
  const { client } = await connectScheduleClient(options.host);
  try {
    const maxRuns = options.maxRuns ? Number.parseInt(options.maxRuns, 10) : undefined;
    if (maxRuns !== undefined && (!Number.isSafeInteger(maxRuns) || maxRuns <= 0)) {
      throw new Error("--max-runs must be a positive integer");
    }
    const payload = await client.scheduleCreate({
      prompt: prompt.trim(),
      cadence: {
        type: "cron",
        expression: cron,
        ...(options.timezone?.trim() ? { timezone: options.timezone.trim() } : {}),
      },
      target: { type: "agent", agentId },
      ...(options.name?.trim() ? { name: options.name.trim() } : {}),
      ...(maxRuns ? { maxRuns } : {}),
      ...(options.expiresIn
        ? { expiresAt: new Date(Date.now() + parseDuration(options.expiresIn)).toISOString() }
        : {}),
    });
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? "Heartbeat creation failed");
    }
    return { type: "single", data: toScheduleRow(payload.schedule), schema: scheduleSchema };
  } catch (error) {
    throw toScheduleCommandError("HEARTBEAT_CREATE_FAILED", "create heartbeat", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runUpdateHeartbeat(
  id: string,
  options: HeartbeatOptions,
  _command: Command,
): Promise<SingleResult<ScheduleRow>> {
  const agentId = requireCallerAgentId();
  const cron = options.cron?.trim();
  if (!cron) {
    throw new Error("--cron is required");
  }
  const { client } = await connectScheduleClient(options.host);
  try {
    await requireOwnedHeartbeat(client, id, agentId);
    const payload = await client.scheduleUpdate({
      id,
      cadence: {
        type: "cron",
        expression: cron,
        ...(options.timezone?.trim() ? { timezone: options.timezone.trim() } : {}),
      },
    });
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? `Heartbeat update failed: ${id}`);
    }
    return { type: "single", data: toScheduleRow(payload.schedule), schema: scheduleSchema };
  } catch (error) {
    throw toScheduleCommandError("HEARTBEAT_UPDATE_FAILED", "update heartbeat", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runDeleteHeartbeat(
  id: string,
  options: HeartbeatOptions,
  _command: Command,
): Promise<SingleResult<HeartbeatDeleteRow>> {
  const agentId = requireCallerAgentId();
  const { client } = await connectScheduleClient(options.host);
  try {
    await requireOwnedHeartbeat(client, id, agentId);
    const payload = await client.scheduleDelete({ id });
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "single",
      data: { id: payload.scheduleId, status: "deleted" },
      schema: heartbeatDeleteSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("HEARTBEAT_DELETE_FAILED", "delete heartbeat", error);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function createHeartbeatCommand(): Command {
  const heartbeat = new Command("heartbeat").description("Manage this agent's heartbeats");
  addJsonAndDaemonHostOptions(
    heartbeat
      .command("create")
      .description("Create a recurring prompt for this agent")
      .argument("<prompt>", "Prompt to send")
      .requiredOption("--cron <expr>", "Five-field cron cadence")
      .option("--timezone <iana>", "IANA time zone")
      .option("--name <name>", "Heartbeat name")
      .option("--max-runs <n>", "Maximum number of runs")
      .option("--expires-in <duration>", "Time to live"),
  ).action(withOutput(runCreateHeartbeat));
  addJsonAndDaemonHostOptions(
    heartbeat
      .command("update")
      .description("Change a heartbeat cron cadence")
      .argument("<id>", "Heartbeat ID")
      .requiredOption("--cron <expr>", "Five-field cron cadence")
      .option("--timezone <iana>", "IANA time zone"),
  ).action(withOutput(runUpdateHeartbeat));
  addJsonAndDaemonHostOptions(
    heartbeat.command("delete").description("Delete a heartbeat").argument("<id>", "Heartbeat ID"),
  ).action(withOutput(runDeleteHeartbeat));
  return heartbeat;
}
