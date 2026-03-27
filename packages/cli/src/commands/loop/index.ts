import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, addDaemonHostOption } from "../../utils/command-options.js";
import { addLoopRunOptions, runLoopRunCommand } from "./run.js";
import { addLoopLsOptions, runLoopLsCommand } from "./ls.js";
import { addLoopInspectOptions, runLoopInspectCommand } from "./inspect.js";
import { addLoopLogsOptions, runLoopLogsCommand } from "./logs.js";
import { addLoopStopOptions, runLoopStopCommand } from "./stop.js";

export function createLoopCommand(): Command {
  const loop = new Command("loop").description("Run iterative worker loops");

  addJsonAndDaemonHostOptions(
    addLoopRunOptions(loop.command("run")),
  ).action(withOutput(runLoopRunCommand));

  addJsonAndDaemonHostOptions(
    addLoopLsOptions(loop.command("ls")),
  ).action(withOutput(runLoopLsCommand));

  addJsonAndDaemonHostOptions(
    addLoopInspectOptions(loop.command("inspect")),
  ).action(withOutput(runLoopInspectCommand));

  addDaemonHostOption(
    addLoopLogsOptions(loop.command("logs")),
  ).action(runLoopLogsCommand);

  addJsonAndDaemonHostOptions(
    addLoopStopOptions(loop.command("stop")),
  ).action(withOutput(runLoopStopCommand));

  return loop;
}
