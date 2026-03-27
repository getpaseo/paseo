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
import type { LoopDaemonClient, LoopRecord, LoopRunInput } from "./types.js";

export interface LoopRunRow {
  id: string;
  status: string;
  name: string | null;
  cwd: string;
}

export interface LoopRunOptions extends CommandOptions {
  verify?: string;
  verifyCheck?: string[];
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
    .option("--verify <prompt>", "Verifier agent prompt")
    .option(
      "--verify-check <command>",
      "Shell command that must exit 0 (repeatable)",
      collectMultiple,
      [],
    )
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

function buildLoopRunInput(prompt: string, options: LoopRunOptions): LoopRunInput {
  const verifyPrompt = options.verify?.trim();
  if (options.verify !== undefined && !verifyPrompt) {
    throw {
      code: "INVALID_VERIFY_PROMPT",
      message: "--verify cannot be empty",
    } satisfies CommandError;
  }

  return {
    prompt,
    cwd: process.cwd(),
    ...(verifyPrompt ? { verifyPrompt } : {}),
    ...(options.verifyCheck && options.verifyCheck.length > 0
      ? { verifyChecks: options.verifyCheck }
      : {}),
    ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    ...(options.sleep ? { sleepMs: parseDuration(options.sleep) } : {}),
    ...(options.maxIterations ? { maxIterations: parseMaxIterations(options.maxIterations) } : {}),
    ...(options.maxTime ? { maxTimeMs: parseDuration(options.maxTime) } : {}),
  };
}

export type LoopRunResult = SingleResult<LoopRunRow>;

export async function runLoopRunCommand(
  prompt: string,
  options: LoopRunOptions,
  _command: Command,
): Promise<LoopRunResult> {
  const host = getDaemonHost({ host: options.host as string | undefined });
  const input = buildLoopRunInput(prompt, options);
  let client;
  try {
    client = (await connectToDaemon({
      host: options.host as string | undefined,
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
