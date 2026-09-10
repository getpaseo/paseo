import type { Command } from "commander";
import {
  resolveLocalDaemonState,
  startLocalDaemonDetached,
  stopLocalDaemon,
  DEFAULT_STOP_TIMEOUT_MS,
  type DaemonStartOptions,
} from "./local-daemon.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

interface RestartResult {
  action: "restarted";
  home: string;
  pid: string;
  message: string;
}

const restartResultSchema: OutputSchema<RestartResult> = {
  idField: "action",
  columns: [
    {
      header: "STATUS",
      field: "action",
      color: () => "green",
    },
    { header: "HOME", field: "home" },
    { header: "PID", field: "pid" },
    { header: "MESSAGE", field: "message" },
  ],
};

export interface DaemonRestartRuntime {
  resolveState: typeof resolveLocalDaemonState;
  stop: typeof stopLocalDaemon;
  start: typeof startLocalDaemonDetached;
}

const defaultRestartRuntime: DaemonRestartRuntime = {
  resolveState: resolveLocalDaemonState,
  stop: stopLocalDaemon,
  start: startLocalDaemonDetached,
};

export type RestartCommandResult = SingleResult<RestartResult>;

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

function toStartOptions(options: CommandOptions): DaemonStartOptions {
  const startOptions: DaemonStartOptions = {
    home: typeof options.home === "string" ? options.home : undefined,
    listen: typeof options.listen === "string" ? options.listen : undefined,
    port: typeof options.port === "string" ? options.port : undefined,
    relay: typeof options.relay === "boolean" ? options.relay : undefined,
    mcp: typeof options.mcp === "boolean" ? options.mcp : undefined,
    injectMcp: typeof options.injectMcp === "boolean" ? options.injectMcp : undefined,
    webUi: typeof options.webUi === "boolean" ? options.webUi : undefined,
    hostnames: typeof options.hostnames === "string" ? options.hostnames : undefined,
  };

  if (startOptions.listen && startOptions.port) {
    const error: CommandError = {
      code: "INVALID_OPTIONS",
      message: "Cannot use --listen and --port together",
    };
    throw error;
  }

  return startOptions;
}

export async function runRestartCommand(
  options: CommandOptions,
  _command: Command,
  runtime: DaemonRestartRuntime = defaultRestartRuntime,
): Promise<RestartCommandResult> {
  const timeoutMs = parseTimeoutMs(options.timeout);
  const force = options.force === true;
  const startOptions = toStartOptions(options);

  try {
    // Capture the effective target before stop removes the old supervisor's PID file.
    const state = runtime.resolveState({ home: startOptions.home });
    startOptions.home = state.home;
    const previousListen = state.running ? state.pidInfo?.listen : undefined;
    const hasListenOverride = Boolean(startOptions.listen || startOptions.port);
    if (!hasListenOverride && previousListen) {
      startOptions.listen = previousListen;
    }
    let stopResult: Awaited<ReturnType<typeof stopLocalDaemon>>;
    try {
      stopResult = await runtime.stop({
        home: startOptions.home,
        timeoutMs,
        force,
      });
    } catch (err) {
      const isTimeout =
        err instanceof Error && err.message.includes("Timed out waiting for daemon PID");
      if (!force && isTimeout) {
        stopResult = await runtime.stop({
          home: startOptions.home,
          timeoutMs,
          force: true,
        });
      } else {
        throw err;
      }
    }

    const startup = await runtime.start(startOptions);
    const before = stopResult.pid === null ? "not running" : `PID ${stopResult.pid}`;
    const after = startup.pid === null ? "unknown PID" : `PID ${startup.pid}`;

    return {
      type: "single",
      data: {
        action: "restarted",
        home: stopResult.home,
        pid: startup.pid === null ? "-" : String(startup.pid),
        message: `Local daemon restarted (${before} -> ${after})`,
      },
      schema: restartResultSchema,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "RESTART_FAILED",
      message: `Failed to restart local daemon: ${message}`,
    };
    throw error;
  }
}
