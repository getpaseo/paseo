import { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandOptions,
  CommandError,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { collectMultiple } from "../../utils/command-options.js";
import { parseDuration } from "../../utils/duration.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import type { LoopDaemonClient, LoopRecord, LoopRunInput } from "./types.js";

export interface LoopRunRow {
  id: string;
  status: string;
  name: string | null;
  cwd: string;
}

export interface LoopRunOptions extends CommandOptions {
  provider?: string;
  model?: string;
  mode?: string;
  verifyProvider?: string;
  verifyModel?: string;
  verifyMode?: string;
  verify?: string;
  verifyCheck?: string[];
  archive?: boolean;
  name?: string;
  sleep?: string;
  maxIterations?: string;
  maxTime?: string;
}

export const loopRunSchema: OutputSchema<LoopRunRow> = {
  idField: "id",
  columns: [
    { header: "LOOP ID", field: "id", width: 10 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "NAME", field: "name", width: 20 },
    { header: "CWD", field: "cwd", width: 40 },
  ],
};

export function addLoopRunOptions(command: Command): Command {
  return command
    .description("Start a loop")
    .argument("<prompt>", "Prompt for each fresh worker iteration")
    .option("--provider <provider>", "Default provider for worker and verifier agents")
    .option("--model <model>", "Default model for worker and verifier agents")
    .option(
      "--mode <mode>",
      "Provider-specific mode for the worker agent (e.g. claude bypassPermissions, opencode build)",
    )
    .option("--verify-provider <provider>", "Provider for the verifier agent")
    .option("--verify-model <model>", "Model for the verifier agent")
    .option("--verify-mode <mode>", "Provider-specific mode for the verifier agent")
    .option("--verify <prompt>", "Verifier agent prompt")
    .option(
      "--verify-check <command>",
      "Shell command that must exit 0 (repeatable)",
      collectMultiple,
      [],
    )
    .option("--archive", "Archive worker and verifier agents after each iteration")
    .option("--name <name>", "Optional loop name")
    .option("--sleep <duration>", "Delay between iterations (for example: 30s, 5m)")
    .option("--max-iterations <n>", "Maximum number of iterations")
    .option("--max-time <duration>", "Maximum total runtime (for example: 1h, 30m)");
}

function toRow(loop: LoopRecord): LoopRunRow {
  return {
    id: loop.id,
    status: loop.status,
    name: loop.name,
    cwd: loop.cwd,
  };
}

function parseMaxIterations(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw {
      code: "INVALID_MAX_ITERATIONS",
      message: "--max-iterations must be a positive integer",
    } satisfies CommandError;
  }
  return parsed;
}

// oxlint-disable complexity
export function buildLoopRunInput(prompt: string, options: LoopRunOptions): LoopRunInput {
  const verifyPrompt = options.verify?.trim();
  if (options.verify !== undefined && !verifyPrompt) {
    throw {
      code: "INVALID_VERIFY_PROMPT",
      message: "--verify cannot be empty",
    } satisfies CommandError;
  }

  const result: LoopRunInput = {
    prompt,
    cwd: process.cwd(),
  };

  // Resolve provider/model
  if (options.provider) {
    const { provider, model } = resolveProviderAndModel({ provider: options.provider });
    if (provider) result.provider = provider;
    // Explicit --model takes precedence over parsed model
    if (options.model?.trim()) {
      result.model = options.model.trim();
    } else if (model) {
      result.model = model;
    }
  } else if (options.model?.trim()) {
    result.model = options.model.trim();
  }

  if (options.mode?.trim()) {
    result.modeId = options.mode.trim();
  }

  // Resolve verifier provider/model
  if (options.verifyProvider) {
    const { provider, model } = resolveProviderAndModel({ provider: options.verifyProvider });
    if (provider) result.verifierProvider = provider;
    // Explicit --verify-model takes precedence over parsed model
    if (options.verifyModel?.trim()) {
      result.verifierModel = options.verifyModel.trim();
    } else if (model) {
      result.verifierModel = model;
    }
  } else if (options.verifyModel?.trim()) {
    result.verifierModel = options.verifyModel.trim();
  }

  if (options.verifyMode?.trim()) {
    result.verifierModeId = options.verifyMode.trim();
  }

  if (verifyPrompt) result.verifyPrompt = verifyPrompt;
  if (options.verifyCheck && options.verifyCheck.length > 0) {
    result.verifyChecks = options.verifyCheck;
  }
  if (options.archive) result.archive = true;
  if (options.name?.trim()) result.name = options.name.trim();
  if (options.sleep) result.sleepMs = parseDuration(options.sleep);
  if (options.maxIterations) {
    result.maxIterations = parseMaxIterations(options.maxIterations);
  }
  if (options.maxTime) result.maxTimeMs = parseDuration(options.maxTime);

  return result;
}
// oxlint-enable complexity

export type LoopRunResult = SingleResult<LoopRunRow>;

export async function runLoopRunCommand(
  prompt: string,
  options: LoopRunOptions,
  _command: Command,
): Promise<LoopRunResult> {
  const host = getDaemonHost({ host: options.host });
  const input = buildLoopRunInput(prompt, options);
  let client;
  try {
    client = (await connectToDaemon({
      host: options.host,
    })) as unknown as LoopDaemonClient;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }

  try {
    const payload = await client.loopRun(input);
    await client.close();
    if (payload.error || !payload.loop) {
      throw new Error(payload.error ?? "Loop creation failed");
    }
    return {
      type: "single",
      data: toRow(payload.loop),
      schema: loopRunSchema,
    };
  } catch (error) {
    await client.close().catch(() => {});
    if (error && typeof error === "object" && "code" in error) {
      throw error;
    }
    throw {
      code: "LOOP_RUN_FAILED",
      message: error instanceof Error ? error.message : String(error),
    } satisfies CommandError;
  }
}
