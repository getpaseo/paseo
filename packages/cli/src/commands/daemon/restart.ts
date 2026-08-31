import type { Command } from "commander";
import {
  resolveLocalDaemonState,
  resolveLocalPaseoHome,
  startLocalDaemonDetached,
  stopLocalDaemon,
  DEFAULT_STOP_TIMEOUT_MS,
  type DaemonStartOptions,
} from "./local-daemon.js";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

interface RestartResult {
  action: "restarted" | "restart_requested";
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

export type RestartCommandResult = SingleResult<RestartResult>;

interface RestartDaemonClient {
  restartServer(reason?: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface RestartCommandDependencies {
  env: NodeJS.ProcessEnv;
  connectToDaemon(options: { host?: string; timeout?: number }): Promise<RestartDaemonClient>;
  resolveLocalDaemonState: typeof resolveLocalDaemonState;
  resolveLocalPaseoHome: typeof resolveLocalPaseoHome;
  startLocalDaemonDetached: typeof startLocalDaemonDetached;
  stopLocalDaemon: typeof stopLocalDaemon;
}

const defaultDependencies: RestartCommandDependencies = {
  env: process.env,
  connectToDaemon,
  resolveLocalDaemonState,
  resolveLocalPaseoHome,
  startLocalDaemonDetached,
  stopLocalDaemon,
};

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

function hasLaunchOverrides(options: DaemonStartOptions): boolean {
  return (
    options.listen !== undefined ||
    options.port !== undefined ||
    options.relay !== undefined ||
    options.mcp === false ||
    options.injectMcp === false ||
    options.webUi !== undefined ||
    options.hostnames !== undefined
  );
}

function targetsOwningDaemon(
  options: DaemonStartOptions,
  dependencies: RestartCommandDependencies,
): boolean {
  if (!dependencies.env.PASEO_AGENT_ID?.trim()) {
    return false;
  }

  return dependencies.resolveLocalPaseoHome(options.home) === dependencies.resolveLocalPaseoHome();
}

async function requestSupervisedRestart(
  options: DaemonStartOptions,
  timeoutMs: number,
  dependencies: RestartCommandDependencies,
): Promise<RestartCommandResult> {
  const state = dependencies.resolveLocalDaemonState({ home: options.home });
  const client = await dependencies.connectToDaemon({
    host: state.listen,
    timeout: timeoutMs,
  });
  try {
    await client.restartServer("cli_daemon_restart");
  } finally {
    await client.close().catch(() => undefined);
  }

  const pid = state.pidInfo?.pid ?? null;
  return {
    type: "single",
    data: {
      action: "restart_requested",
      home: state.home,
      pid: pid === null ? "-" : String(pid),
      message:
        pid === null
          ? "Daemon worker restart requested through its supervisor"
          : `Daemon worker restart requested through supervisor PID ${pid}`,
    },
    schema: restartResultSchema,
  };
}

export async function runRestartCommand(
  options: CommandOptions,
  _command: Command,
  dependencies: RestartCommandDependencies = defaultDependencies,
): Promise<RestartCommandResult> {
  const timeoutMs = parseTimeoutMs(options.timeout);
  const force = options.force === true;
  const startOptions = toStartOptions(options);

  if (targetsOwningDaemon(startOptions, dependencies)) {
    if (hasLaunchOverrides(startOptions)) {
      const error: CommandError = {
        code: "INVALID_OPTIONS",
        message: "Cannot change daemon launch options from a Paseo-owned agent",
        details: "Run the restart from an external shell, or omit the launch options",
      };
      throw error;
    }

    try {
      return await requestSupervisedRestart(startOptions, timeoutMs, dependencies);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error: CommandError = {
        code: "RESTART_FAILED",
        message: `Failed to request supervised daemon restart: ${message}`,
      };
      throw error;
    }
  }

  try {
    let stopResult: Awaited<ReturnType<typeof stopLocalDaemon>>;
    try {
      stopResult = await dependencies.stopLocalDaemon({
        home: startOptions.home,
        timeoutMs,
        force,
      });
    } catch (err) {
      const isTimeout =
        err instanceof Error && err.message.includes("Timed out waiting for daemon PID");
      if (!force && isTimeout) {
        stopResult = await dependencies.stopLocalDaemon({
          home: startOptions.home,
          timeoutMs,
          force: true,
        });
      } else {
        throw err;
      }
    }

    const startup = await dependencies.startLocalDaemonDetached(startOptions);
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
