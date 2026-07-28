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

export function createScriptCommand(): Command {
  const script = new Command("script").description("Manage configured workspace scripts");

  addJsonAndDaemonHostOptions(
    addWorkspaceSelectionOptions(
      script.command("ls").description("List configured workspace scripts"),
    ),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    addWorkspaceSelectionOptions(
      script.command("start").description("Start a configured workspace script").argument("<name>"),
    ),
  ).action(withOutput(runStartCommand));

  addJsonAndDaemonHostOptions(
    addWorkspaceSelectionOptions(
      script.command("stop").description("Stop a running workspace script").argument("<name>"),
    ),
  ).action(withOutput(runStopCommand));

  return script;
}
