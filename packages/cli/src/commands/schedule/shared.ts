import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import type {
  CreateScheduleInput,
  ScheduleCadence,
  ScheduleDaemonClient,
  ScheduleListItem,
  ScheduleRecord,
  ScheduleTarget,
} from "./types.js";
import { parseDuration } from "../../utils/duration.js";

export interface ScheduleCommandOptions extends CommandOptions {
  host?: string;
}

export async function connectScheduleClient(
  host: string | undefined,
): Promise<{ client: ScheduleDaemonClient; host: string }> {
  const resolvedHost = getDaemonHost({ host });
  try {
    const client = (await connectToDaemon({
      host,
    })) as unknown as ScheduleDaemonClient;
    return { client, host: resolvedHost };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export function toScheduleCommandError(
  code: string,
  action: string,
  error: unknown,
): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

export function formatCadence(cadence: ScheduleCadence): string {
  if (cadence.type === "cron") {
    return `cron:${cadence.expression}`;
  }
  return `every:${formatDurationMs(cadence.everyMs)}`;
}

export function formatTarget(target: ScheduleTarget | ScheduleListItem["target"]): string {
  if (target.type === "self") {
    return `self:${target.agentId.slice(0, 7)}`;
  }
  if (target.type === "agent") {
    return `agent:${target.agentId.slice(0, 7)}`;
  }
  return `new-agent:${target.config.provider}`;
}

export function formatDurationMs(durationMs: number): string {
  const parts: string[] = [];
  let remainingMs = durationMs;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  if (hours > 0) {
    parts.push(`${hours}h`);
    remainingMs -= hours * 60 * 60 * 1000;
  }
  const minutes = Math.floor(remainingMs / (60 * 1000));
  if (minutes > 0) {
    parts.push(`${minutes}m`);
    remainingMs -= minutes * 60 * 1000;
  }
  const seconds = Math.floor(remainingMs / 1000);
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join("");
}

export function parseScheduleCreateInput(options: {
  prompt: string;
  every?: string;
  cron?: string;
  name?: string;
  target?: string;
  maxRuns?: string;
  expiresIn?: string;
}): CreateScheduleInput {
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw {
      code: "INVALID_PROMPT",
      message: "Schedule prompt cannot be empty",
    } satisfies CommandError;
  }

  const cadenceCount = Number(options.every !== undefined) + Number(options.cron !== undefined);
  if (cadenceCount !== 1) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify exactly one of --every or --cron",
    } satisfies CommandError;
  }

  const cadence: ScheduleCadence = options.every
    ? { type: "every", everyMs: parseDuration(options.every) }
    : { type: "cron", expression: options.cron!.trim() };

  const targetValue = options.target?.trim();
  let target: ScheduleTarget;
  if (!targetValue || targetValue === "self") {
    const currentAgentId = process.env.PASEO_AGENT_ID?.trim();
    if (currentAgentId) {
      target = { type: "self", agentId: currentAgentId };
    } else {
      target = {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: process.cwd(),
        },
      };
    }
  } else if (targetValue === "new-agent") {
    target = {
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: process.cwd(),
      },
    };
  } else {
    target = {
      type: "agent",
      agentId: targetValue,
    };
  }

  const maxRuns =
    options.maxRuns === undefined ? undefined : parsePositiveInt(options.maxRuns, "--max-runs");
  const expiresAt =
    options.expiresIn === undefined
      ? undefined
      : new Date(Date.now() + parseDuration(options.expiresIn)).toISOString();

  return {
    prompt,
    cadence,
    target,
    ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw {
      code: "INVALID_INTEGER",
      message: `${flag} must be a positive integer`,
    } satisfies CommandError;
  }
  return parsed;
}

export interface ScheduleRow {
  id: string;
  name: string | null;
  cadence: string;
  target: string;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export function toScheduleRow(schedule: ScheduleListItem | ScheduleRecord): ScheduleRow {
  return {
    id: schedule.id,
    name: schedule.name,
    cadence: formatCadence(schedule.cadence),
    target: formatTarget(schedule.target),
    status: schedule.status,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
  };
}
