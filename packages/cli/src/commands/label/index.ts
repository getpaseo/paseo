import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runCreateCommand } from "./create.js";
import { runDeleteCommand } from "./delete.js";
import { runLsCommand } from "./ls.js";

export function createLabelCommand(): Command {
  const label = new Command("label").description("Manage workspace labels");

  addJsonAndDaemonHostOptions(label.command("ls").description("List workspace labels")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    label
      .command("create")
      .description("Create an unassigned workspace label")
      .argument("<name>", "Label name")
      .option("--color <color>", "Label color (default: violet)")
      .allowExcessArguments(false),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    label
      .command("delete")
      .description("Delete a workspace label and remove its workspace assignments")
      .argument("<name>", "Label name")
      .allowExcessArguments(false),
  ).action(withOutput(runDeleteCommand));

  return label;
}
