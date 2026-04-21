import { Command } from "commander";

import {
  addDaemonHostOption,
  addJsonAndDaemonHostOptions,
  addJsonOption,
} from "../../utils/command-options.js";
import { withOutput } from "../../output/index.js";
import { runWeChatLoginCommand } from "./login.js";
import { runWeChatSessionsCommand } from "./sessions.js";
import { runWeChatStatusCommand } from "./status.js";

export function addWeChatLoginOptions(command: Command): Command {
  return addDaemonHostOption(addJsonOption(command))
    .option("--timeout <seconds>", "Wait timeout in seconds before login fails (default: 240)")
    .option("--bot-type <type>", "Optional upstream WeChat bot type override");
}

function mergeCommandOptions(options: Record<string, unknown>, command: Command): Record<string, unknown> {
  const commandWithGlobals = command as Command & {
    optsWithGlobals?: () => Record<string, unknown>;
  };
  const globalOptions =
    typeof commandWithGlobals.optsWithGlobals === "function"
      ? commandWithGlobals.optsWithGlobals()
      : {};
  return {
    ...globalOptions,
    ...options,
  };
}

export function createWeChatCommand(): Command {
  const wechat = new Command("wechat").description("Manage the WeChat direct channel");

  addWeChatLoginOptions(
    wechat
      .command("login")
      .description("Show a WeChat QR code in the terminal and wait for login"),
  )
    .action((options, command) =>
      runWeChatLoginCommand(mergeCommandOptions(options, command), command),
    );

  addJsonAndDaemonHostOptions(
    wechat
      .command("status")
      .description("Show connected WeChat accounts and runtime status"),
  ).action(withOutput(runWeChatStatusCommand));

  addJsonAndDaemonHostOptions(
    wechat
      .command("sessions")
      .description("Show WeChat peer-to-agent session mappings"),
  ).action(withOutput(runWeChatSessionsCommand));

  return wechat;
}
