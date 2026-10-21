import { Command } from "commander";
import {
  requireTerminalKeepCapability,
  type DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import { stopDaemonInstance, type DaemonInstance } from "@getpaseo/server/daemon-control";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { describeDaemonTarget } from "../../utils/daemon-target.js";
import { parseTimeoutMs } from "./local-daemon.js";

export function daemonStopCommand(): Command {
  return addJsonAndDaemonHostOptions(new Command("stop").description("Stop the selected daemon"))
    .option("--timeout <seconds>", "Graceful exit deadline (default: 15)")
    .option("--force", "Permit forced local process cleanup")
    .option(
      "--keep-terminals",
      "Leave terminals running; the next daemon started for this home takes them back",
    )
    .option("--kill-timeout <seconds>", "Forced exit deadline (default: 3)")
    .action(withOutput(runStopCommand));
}

// The daemon connection stop needs; stop.test.ts passes an in-memory adapter.
export type StopDaemonConnection = Pick<
  DaemonClient,
  "getLastServerInfoMessage" | "shutdownServer" | "close"
>;

export interface StopCommandDeps {
  connectToDaemon(options: ConnectOptions): Promise<StopDaemonConnection>;
}

export const runStopCommand = createStopCommandRunner({ connectToDaemon });

export function createStopCommandRunner(deps: StopCommandDeps) {
  return (options: CommandOptions, _command: Command) => runStop(options, deps);
}

async function runStop(options: CommandOptions, deps: StopCommandDeps) {
  const target = options.daemonTarget;
  const timeoutMs = parseTimeoutMs(options.timeout, 15_000);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const keepTerminals = options.keepTerminals === true;
  const requestShutdown = async (instance?: DaemonInstance) => {
    const client = await deps.connectToDaemon({ target, timeout: remaining(), instance });
    try {
      // Checked on the connection that carries the shutdown: a daemon without the capability
      // would close the terminals it was asked to keep.
      if (keepTerminals) requireTerminalKeepCapability(client, describeDaemonTarget(target));
      await client.shutdownServer({ timeout: remaining(), keepTerminals });
    } finally {
      await client.close();
    }
  };
  if (target.kind === "endpoint" && options.force)
    throw {
      code: "INVALID_OPTIONS",
      message: "--force requires a local --home; an endpoint gives no remote process authority.",
    };
  if (options.force && keepTerminals)
    throw {
      code: "INVALID_OPTIONS",
      message: "--force kills terminals; it cannot be combined with --keep-terminals.",
    };
  const result: {
    action: string;
    home?: string;
    host?: string;
    pid?: number | null;
    forced?: boolean;
    usedLifecycleRpc?: boolean;
  } =
    target.kind === "instance"
      ? {
          ...(await stopDaemonInstance(target.home, {
            force: options.force === true,
            keepTerminals,
            timeoutMs,
            killTimeoutMs: parseTimeoutMs(options.killTimeout, 3_000),
            requestShutdown,
          })),
          home: target.home,
        }
      : (await requestShutdown(),
        { action: "shutdown_requested", host: describeDaemonTarget(target) });
  return {
    type: "single" as const,
    data: result,
    schema: {
      idField: "action" as const,
      columns: [],
      renderHuman: () =>
        target.kind === "endpoint"
          ? "Shutdown requested; remote process exit was not verified."
          : `${result.action.replaceAll("_", " ")}: ${target.home}`,
    },
  };
}
