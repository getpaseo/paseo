import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import type {
  CreateScheduleInput,
  ScheduleCadence,
  ScheduleDaemonClient,
  ScheduleListItem,
  ScheduleRecord,
  ScheduleTarget,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "./types.js";
import { parseDuration } from "../../utils/duration.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";

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

export function toScheduleCommandError(code: string, action: string, error: unknown): CommandError {
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
  const modelSuffix = target.config.model ? `/${target.config.model}` : "";
  return `new-agent:${target.config.provider}${modelSuffix}`;
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

function resolveScheduleTarget(args: {
  targetValue: string | undefined;
  hasExplicitNewAgentOption: boolean;
  createNewAgentTarget: () => ScheduleTarget;
}): ScheduleTarget {
  const { targetValue, hasExplicitNewAgentOption, createNewAgentTarget } = args;
  const currentAgentId = process.env.PASEO_AGENT_ID?.trim();

  if (!targetValue) {
    if (currentAgentId && !hasExplicitNewAgentOption) {
      return { type: "self", agentId: currentAgentId };
    }
    return createNewAgentTarget();
  }

  if (targetValue === "new-agent") {
    return createNewAgentTarget();
  }

  if (hasExplicitNewAgentOption) {
    throw {
      code: "INVALID_TARGET",
      message: "--provider/--mode can only be used with a new-agent target",
      details: "Use --target new-agent or omit --target to create a new agent schedule",
    } satisfies CommandError;
  }

  if (targetValue === "self") {
    if (!currentAgentId) {
      throw {
        code: "INVALID_TARGET",
        message: "--target self requires running inside a Paseo agent",
      } satisfies CommandError;
    }
    return { type: "self", agentId: currentAgentId };
  }

  return { type: "agent", agentId: targetValue };
}

export function parseScheduleCreateInput(options: {
  prompt: string;
  every?: string;
  cron?: string;
  name?: string;
  target?: string;
  provider?: string;
  mode?: string;
  cwd?: string;
  host?: string;
  maxRuns?: string;
  expiresIn?: string;
  runNow?: boolean;
}): CreateScheduleInput {
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw {
      code: "INVALID_PROMPT",
      message: "Schedule prompt cannot be empty",
    } satisfies CommandError;
  }

  const cadence = parseCadenceFromFlags(options.every, options.cron);
  if (!cadence) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify exactly one of --every or --cron",
    } satisfies CommandError;
  }

  const cwdInput = options.cwd?.trim();
  if (options.host !== undefined && !cwdInput) {
    throw {
      code: "MISSING_CWD",
      message:
        "--cwd is required when --host is specified (the local working directory will not exist on the remote daemon)",
    } satisfies CommandError;
  }

  const runOnCreate = resolveRunOnCreate(options.runNow, cadence.type);

  const targetValue = options.target?.trim();
  const modeId = options.mode?.trim();
  const hasExplicitNewAgentOption = options.provider !== undefined || options.mode !== undefined;
  const createNewAgentTarget = (): ScheduleTarget => {
    const resolvedProviderModel = resolveProviderAndModel({
      provider: options.provider,
    });
    return {
      type: "new-agent",
      config: {
        provider: resolvedProviderModel.provider,
        cwd: cwdInput ?? process.cwd(),
        ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
        ...(modeId ? { modeId } : {}),
      },
    };
  };
  const target = resolveScheduleTarget({
    targetValue,
    hasExplicitNewAgentOption,
    createNewAgentTarget,
  });

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
    runOnCreate,
    ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function resolveRunOnCreate(
  runNow: boolean | undefined,
  cadenceType: ScheduleCadence["type"],
): boolean {
  if (runNow === true && cadenceType === "every") {
    throw {
      code: "REDUNDANT_RUN_NOW",
      message: "--run-now is redundant with --every (interval schedules already fire on creation)",
      details: "Drop --run-now, or use --no-run-now to wait the full interval before the first run",
    } satisfies CommandError;
  }
  if (runNow === false && cadenceType === "cron") {
    throw {
      code: "REDUNDANT_NO_RUN_NOW",
      message: "--no-run-now is redundant with --cron (cron schedules never fire on creation)",
      details: "Drop --no-run-now, or use --run-now to fire one immediate run on creation",
    } satisfies CommandError;
  }
  return runNow ?? cadenceType === "every";
}

export interface ScheduleUpdateOptionsInput {
  id: string;
  every?: string;
  cron?: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  maxRuns?: string;
  expiresIn?: string;
  clearMaxRuns?: boolean;
  clearExpires?: boolean;
}

export function parseScheduleUpdateInput(options: ScheduleUpdateOptionsInput): UpdateScheduleInput {
  const id = options.id.trim();
  if (!id) {
    throw {
      code: "INVALID_SCHEDULE_ID",
      message: "Schedule id cannot be empty",
    } satisfies CommandError;
  }

  const cadence = parseCadenceFromFlags(options.every, options.cron);
  const newAgentConfig = buildNewAgentConfigPatch(options);
  const maxRuns = parseUpdateMaxRuns(options);
  const expiresAt = parseUpdateExpiresAt(options);
  const name = parseUpdateName(options);
  const prompt = parseUpdatePrompt(options);

  if (
    name === undefined &&
    prompt === undefined &&
    cadence === undefined &&
    newAgentConfig === undefined &&
    maxRuns === undefined &&
    expiresAt === undefined
  ) {
    throw {
      code: "NO_UPDATES",
      message: "Specify at least one field to update",
    } satisfies CommandError;
  }

  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(newAgentConfig !== undefined ? { newAgentConfig } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function parseCadenceFromFlags(
  every: string | undefined,
  cron: string | undefined,
): ScheduleCadence | undefined {
  if (every !== undefined && cron !== undefined) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify at most one of --every or --cron",
    } satisfies CommandError;
  }
  if (every !== undefined) {
    return { type: "every", everyMs: parseDuration(every) };
  }
  if (cron !== undefined) {
    return { type: "cron", expression: cron.trim() };
  }
  return undefined;
}

function parseUpdateMaxRuns(options: ScheduleUpdateOptionsInput): number | null | undefined {
  if (options.maxRuns !== undefined && options.clearMaxRuns) {
    throw {
      code: "CONFLICTING_MAX_RUNS",
      message: "Use either --max-runs <n> or --no-max-runs, not both",
    } satisfies CommandError;
  }
  if (options.clearMaxRuns) {
    return null;
  }
  if (options.maxRuns !== undefined) {
    return parsePositiveInt(options.maxRuns, "--max-runs");
  }
  return undefined;
}

function parseUpdateExpiresAt(options: ScheduleUpdateOptionsInput): string | null | undefined {
  if (options.expiresIn !== undefined && options.clearExpires) {
    throw {
      code: "CONFLICTING_EXPIRES",
      message: "Use either --expires-in <duration> or --no-expires-in, not both",
    } satisfies CommandError;
  }
  if (options.clearExpires) {
    return null;
  }
  if (options.expiresIn !== undefined) {
    return new Date(Date.now() + parseDuration(options.expiresIn)).toISOString();
  }
  return undefined;
}

function parseUpdateName(options: ScheduleUpdateOptionsInput): string | null | undefined {
  if (options.name === undefined) {
    return undefined;
  }
  const trimmed = options.name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseUpdatePrompt(options: ScheduleUpdateOptionsInput): string | undefined {
  if (options.prompt === undefined) {
    return undefined;
  }
  const trimmed = options.prompt.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_PROMPT",
      message: "--prompt cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function buildNewAgentConfigPatch(
  options: ScheduleUpdateOptionsInput,
): UpdateScheduleNewAgentConfig | undefined {
  const patch: UpdateScheduleNewAgentConfig = {};
  if (options.provider !== undefined || options.model !== undefined) {
    const resolved = resolveProviderAndModel({
      provider: options.provider,
      model: options.model,
    });
    patch.provider = resolved.provider;
    if (resolved.model !== undefined) {
      patch.model = resolved.model;
    }
  }
  if (options.mode !== undefined) {
    const trimmed = options.mode.trim();
    patch.modeId = trimmed.length > 0 ? trimmed : null;
  }
  if (options.cwd !== undefined) {
    const trimmed = options.cwd.trim();
    if (!trimmed) {
      throw {
        code: "INVALID_CWD",
        message: "--cwd cannot be empty",
      } satisfies CommandError;
    }
    patch.cwd = trimmed;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
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
