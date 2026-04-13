import type { Command } from "commander";
import { stopLocalDaemon, DEFAULT_STOP_TIMEOUT_MS } from "./local-daemon.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

interface StopResult {
  action: "stopped" | "not_running";
  home: string;
  pid: string;
  message: string;
}

const stopResultSchema: OutputSchema<StopResult> = {
  idField: "action",
  columns: [
    {
      header: "STATUS",
      field: "action",
      color: (value) => (value === "stopped" ? "green" : "yellow"),
    },
    { header: "HOME", field: "home" },
    { header: "PID", field: "pid" },
    { header: "MESSAGE", field: "message" },
  ],
};

export type StopCommandResult = SingleResult<StopResult>;

function parseTimeoutMs(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_STOP_TIMEOUT_MS;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    const error: CommandError = {
      code: "INVALID_TIMEOUT",
      message: `Invalid timeout value: ${raw}`,
      details: "Timeout must be a positive number of seconds",
    };
    throw error;
  }

  return Math.ceil(seconds * 1000);
}

export async function runStopCommand(
  options: CommandOptions,
  _command: Command,
): Promise<StopCommandResult> {
  const home = typeof options.home === "string" ? options.home : undefined;
  const force = options.force === true;
  const timeoutMs = parseTimeoutMs(options.timeout);

  try {
    const result = await stopLocalDaemon({ home, force, timeoutMs });
    return {
      type: "single",
      data: {
        action: result.action,
        home: result.home,
        pid: result.pid === null ? "-" : String(result.pid),
        message: result.message,
      },
      schema: stopResultSchema,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "STOP_FAILED",
      message: `Failed to stop local daemon: ${message}`,
    };
    throw error;
  }
}
