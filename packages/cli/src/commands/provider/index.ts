import { Command } from "commander";
import { runLsCommand } from "./ls.js";
import { runModelsCommand } from "./models.js";
import { addProviderAddOptions, runAddCommand, type ProviderAddDependencies } from "./add.js";
import { runRmCommand, type ProviderRmDependencies } from "./rm.js";
import type { ProviderListItem, ProviderLsDependencies } from "./ls.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export function createProviderCommand(
  dependencies: Partial<
    ProviderAddDependencies & ProviderLsDependencies & ProviderRmDependencies
  > = {},
): Command {
  const provider = new Command("provider").description(
    "Manage Paseo Agent model providers and agent provider models",
  );

  addJsonAndDaemonHostOptions(
    provider.command("ls").description("List configured Paseo Agent model providers"),
  ).action(
    withOutput<ProviderListItem, []>((options, command) =>
      runLsCommand(options, command, dependencies),
    ),
  );

  addJsonAndDaemonHostOptions(
    provider
      .command("models")
      .description("List models for a provider")
      .argument("<provider>", "Provider name")
      .option("--thinking", "Include thinking option IDs for each model"),
  ).action(withOutput(runModelsCommand));

  addJsonAndDaemonHostOptions(addProviderAddOptions(provider.command("add"))).action(
    withOutput<Awaited<ReturnType<typeof runAddCommand>>["data"], [string | undefined]>(
      (id, options, command) => runAddCommand(id, options, command, dependencies),
    ),
  );

  addJsonAndDaemonHostOptions(
    provider
      .command("rm")
      .description("Remove a Paseo Agent model provider")
      .argument("<name>", "Provider instance name"),
  ).action(
    withOutput<Awaited<ReturnType<typeof runRmCommand>>["data"], [string]>(
      (name, options, command) => runRmCommand(name, options, command, dependencies),
    ),
  );

  return provider;
}
