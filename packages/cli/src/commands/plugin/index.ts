import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runBrowseCommand } from "./browse.js";
import { runInstallCommand } from "./install.js";
import { runLsCommand } from "./ls.js";
import { runDisableCommand, runEnableCommand } from "./set-enabled.js";
import { runUninstallCommand } from "./uninstall.js";

export function createPluginCommand(): Command {
  const plugin = new Command("plugin").description("Manage UI plugins");

  addJsonAndDaemonHostOptions(plugin.command("ls").description("List installed plugins")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    plugin
      .command("browse")
      .description("List plugins available in the registry")
      .option("--refresh", "Bypass the daemon's cached registry index"),
  ).action(withOutput(runBrowseCommand));

  addJsonAndDaemonHostOptions(
    plugin
      .command("install")
      .description("Install a plugin from the registry")
      .argument("<id>", "Plugin ID"),
  ).action(withOutput(runInstallCommand));

  addJsonAndDaemonHostOptions(
    plugin.command("uninstall").description("Uninstall a plugin").argument("<id>", "Plugin ID"),
  ).action(withOutput(runUninstallCommand));

  addJsonAndDaemonHostOptions(
    plugin
      .command("enable")
      .description("Enable an installed plugin")
      .argument("<id>", "Plugin ID"),
  ).action(withOutput(runEnableCommand));

  addJsonAndDaemonHostOptions(
    plugin
      .command("disable")
      .description("Disable an installed plugin")
      .argument("<id>", "Plugin ID"),
  ).action(withOutput(runDisableCommand));

  return plugin;
}
