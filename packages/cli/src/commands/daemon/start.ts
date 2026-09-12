import { addLocalDaemonOptions } from "../../utils/command-options.js";
import { Command } from "commander";
import { daemonLogPath } from "@getpaseo/server";
import { launchLocalDaemon, parseTimeoutMs, rejectRemovedLaunchFlags } from "./local-daemon.js";
import { withOutput, type CommandOptions } from "../../output/index.js";

export function startCommand(): Command {
  return rejectRemovedLaunchFlags(addLocalDaemonOptions(new Command("start")))
    .description("Start the local daemon from persistent configuration (local operation)")
    .option("--timeout <seconds>", "Readiness deadline (default: 600)")
    .action(withOutput(runStart));
}

export async function runStart(options: CommandOptions, _command: Command) {
  if (options.daemonTarget.kind !== "instance") throw new Error("Start requires a local home");
  const home = options.daemonTarget.home;
  const result = await launchLocalDaemon({ home, timeoutMs: parseTimeoutMs(options.timeout) });
  const data = {
    action: result.spawned ? "started" : "already_running",
    home,
    pid: result.instance.pid,
    listen: result.instance.listen,
    logPath: daemonLogPath(home),
  };
  return {
    type: "single" as const,
    data,
    schema: {
      idField: "pid" as const,
      columns: [],
      renderHuman: () =>
        `${result.spawned ? "Started" : "Already running"}: PID ${data.pid}${data.listen ? `, listening on ${data.listen}` : ", not ready"}\nLogs: ${data.logPath}`,
    },
  };
}

export function daemonRunCommand(): Command {
  return rejectRemovedLaunchFlags(addLocalDaemonOptions(new Command("run")))
    .description("Run a local daemon in the foreground with deployment environment overrides")
    .action(
      withOutput(async (options: CommandOptions, _command: Command) => {
        if (options.daemonTarget.kind !== "instance") throw new Error("Run requires a local home");
        const result = await launchLocalDaemon({
          home: options.daemonTarget.home,
          foreground: true,
        });
        process.exitCode = result.exitCode ?? 0;
        return {
          type: "single" as const,
          data: { pid: result.instance.pid, action: result.spawned ? "exited" : "already_running" },
          schema: { idField: "pid" as const, columns: [] },
        };
      }),
    );
}
