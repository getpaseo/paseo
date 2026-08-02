import { Command } from "commander";
import { runAddCommand } from "./add.js";
import { runDiagnosticCommand } from "./diagnostic.js";
import { runLsCommand } from "./ls.js";
import { runModelsCommand } from "./models.js";
import { runRmCommand } from "./rm.js";
import { VALID_EXTENDS_VALUES } from "./shared.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions, collectMultiple } from "../../utils/command-options.js";

export function createProviderCommand(): Command {
  const provider = new Command("provider").description("Manage agent providers");

  addJsonAndDaemonHostOptions(
    provider.command("ls").description("List available providers and status"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("models")
      .description("List models for a provider")
      .argument("<provider>", "Provider name (claude, codex, opencode)")
      .option("--thinking", "Include thinking option IDs for each model"),
  ).action(withOutput(runModelsCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("diagnostic")
      .description("Show provider installation, environment, and availability diagnostics")
      .argument("<provider>", "Provider name"),
  ).action(withOutput(runDiagnosticCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("add")
      .description("Add a custom provider profile")
      .argument("<id>", "New provider id (lowercase letters, digits, hyphens)")
      .requiredOption(
        "--extends <provider>",
        `Provider to inherit from (${VALID_EXTENDS_VALUES.join(", ")})`,
      )
      .option("--label <label>", "Display label (default: the provider id)")
      .option("--description <text>", "Description shown next to the label")
      .option("--env <KEY=VALUE>", "Environment variable, repeatable", collectMultiple, [])
      .option(
        "--model <id[=label]>",
        "Model offered by this profile, repeatable; the first is the default",
        collectMultiple,
        [],
      )
      .option(
        "--command <arg>",
        "Launch argv entry, repeatable; required with --extends acp",
        collectMultiple,
        [],
      ),
  ).action(withOutput(runAddCommand));

  addJsonAndDaemonHostOptions(
    provider
      .command("rm")
      .description("Remove a custom provider profile")
      .argument("<id>", "Custom provider id"),
  ).action(withOutput(runRmCommand));

  return provider;
}
