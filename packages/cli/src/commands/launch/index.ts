import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runLsCommand } from "./ls.js";
import { runStartCommand } from "./start.js";
import { runStopCommand } from "./stop.js";

function addWorkspaceSelectionOptions(command: Command): Command {
  return command
    .option("--cwd <path>", "Workspace directory (default: current directory)")
    .option(
      "--workspace <workspace-id>",
      "Workspace ID (required when a directory has multiple workspaces)",
    );
}

export function createLaunchCommand(): Command {
  const launch = new Command("launch").description("Manage configured workspace launches");

  addJsonAndDaemonHostOptions(
    addWorkspaceSelectionOptions(
      launch.command("ls").description("List configured workspace launches"),
    ),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    addWorkspaceSelectionOptions(
      launch.command("start").description("Start a configured workspace launch").argument("<name>"),
    ),
  ).action(withOutput(runStartCommand));

  addJsonAndDaemonHostOptions(
    addWorkspaceSelectionOptions(
      launch.command("stop").description("Stop a running workspace launch").argument("<name>"),
    ),
  ).action(withOutput(runStopCommand));

  return launch;
}
