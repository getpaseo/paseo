import { Command } from "commander";
import { runModeCommand } from "./mode.js";
import { addArchiveOptions, runArchiveCommand } from "./archive.js";
import { addDeleteOptions, runDeleteCommand } from "./delete.js";
import { addLsOptions, runLsCommand } from "./ls.js";
import { addRunOptions, runRunCommand } from "./run.js";
import { addLogsOptions, runLogsCommand } from "./logs.js";
import { addStopOptions, runStopCommand } from "./stop.js";
import { addSendOptions, runSendCommand } from "./send.js";
import { addInspectOptions, runInspectCommand } from "./inspect.js";
import { addWaitOptions, runWaitCommand } from "./wait.js";
import { addAttachOptions, runAttachCommand } from "./attach.js";
import { addReloadOptions, runReloadCommand } from "./reload.js";
import { runUpdateCommand } from "./update.js";
import { withOutput } from "../../output/index.js";
import {
  addDaemonHostOption,
  addJsonAndDaemonHostOptions,
  collectMultiple,
} from "../../utils/command-options.js";

export function createAgentCommand(): Command {
  const agent = new Command("agent").description("Manage agents (advanced operations)");

  // Primary agent commands (same as top-level)
  addJsonAndDaemonHostOptions(addLsOptions(agent.command("ls"))).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(addRunOptions(agent.command("run"))).action(
    withOutput(runRunCommand),
  );

  addDaemonHostOption(addAttachOptions(agent.command("attach"))).action(runAttachCommand);

  addDaemonHostOption(addLogsOptions(agent.command("logs"))).action(runLogsCommand);

  addJsonAndDaemonHostOptions(addStopOptions(agent.command("stop"))).action(
    withOutput(runStopCommand),
  );

  addJsonAndDaemonHostOptions(addDeleteOptions(agent.command("delete"))).action(
    withOutput(runDeleteCommand),
  );

  addJsonAndDaemonHostOptions(addSendOptions(agent.command("send"))).action(
    withOutput(runSendCommand),
  );

  addJsonAndDaemonHostOptions(addInspectOptions(agent.command("inspect"))).action(
    withOutput(runInspectCommand),
  );

  addJsonAndDaemonHostOptions(addWaitOptions(agent.command("wait"))).action(
    withOutput(runWaitCommand),
  );

  // Advanced agent commands (less common operations)
  addJsonAndDaemonHostOptions(
    agent
      .command("mode")
      .description("Change an agent's operational mode")
      .argument("<id>", "Agent ID (or prefix)")
      .argument("[mode]", "Mode to set (required unless --list)")
      .option("--list", "List available modes for this agent"),
  ).action(withOutput(runModeCommand));

  addJsonAndDaemonHostOptions(addArchiveOptions(agent.command("archive"))).action(
    withOutput(runArchiveCommand),
  );

  addJsonAndDaemonHostOptions(addReloadOptions(agent.command("reload"))).action(
    withOutput(runReloadCommand),
  );

  addJsonAndDaemonHostOptions(
    agent
      .command("update")
      .description("Update an agent's metadata")
      .argument("<id>", "Agent ID (or prefix)")
      .option("--name <name>", "Update the agent's display name")
      .option(
        "--label <label>",
        "Add/set label(s) on the agent (can be used multiple times or comma-separated)",
        collectMultiple,
        [],
      ),
  ).action(withOutput(runUpdateCommand));

  return agent;
}
