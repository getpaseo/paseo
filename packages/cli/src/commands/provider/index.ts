import { Command } from "commander";
import { runLsCommand } from "./ls.js";
import { runModelsCommand } from "./models.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export function createProviderCommand(): Command {
  const provider = new Command("provider").description("Manage agent providers");

  addJsonAndDaemonHostOptions(
    provider.command("ls").description("List available providers and status"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("models")
      .description("List models for a provider")
      .argument("<provider>", "Provider name")
      .option("--thinking", "Include thinking option IDs for each model"),
  ).action(withOutput(runModelsCommand));

  return provider;
}
