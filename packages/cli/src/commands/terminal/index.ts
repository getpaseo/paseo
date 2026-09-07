import { Command, Option } from "commander";
import { withOutput } from "../../output/index.js";
import {
  addDaemonHostOption,
  addJsonAndDaemonHostOptions,
  withGlobalOptions,
} from "../../utils/command-options.js";
import { runCaptureCommand } from "./capture.js";
import { runCreateCommand } from "./create.js";
import { runKillCommand } from "./kill.js";
import { runLsCommand } from "./ls.js";
import { runSendKeysCommand } from "./send-keys.js";

export function createTerminalCommand(): Command {
  const terminal = new Command("terminal").description("Manage workspace terminals");

  addJsonAndDaemonHostOptions(
    terminal
      .command("ls")
      .description("List terminals")
      .addOption(
        new Option("--all", "List terminals across all workspaces").conflicts(["cwd", "workspace"]),
      )
      .option("--workspace <id>", "Workspace ID")
      .option("--cwd <path>", "Working directory"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    terminal
      .command("create")
      .description("Create a terminal")
      .option("--workspace <id>", "Workspace ID")
      .option("--cwd <path>", "Working directory")
      .option("--name <name>", "Terminal name"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    terminal
      .command("kill")
      .description("Kill a terminal")
      .argument("<terminal-id>", "Terminal ID, ID prefix, or name"),
  ).action(withOutput(runKillCommand));

  addDaemonHostOption(
    terminal
      .command("capture")
      .description("Capture terminal output")
      .argument("<terminal-id>", "Terminal ID, ID prefix, or name")
      .option("--start <n>", "Capture start line")
      .option("--end <n>", "Capture end line")
      .option("-S, --scrollback", "Capture from the beginning of scrollback")
      .option("--ansi", "Preserve ANSI escape codes")
      .option("--json", "Output in JSON format"),
  ).action(withGlobalOptions(runCaptureCommand));

  addDaemonHostOption(
    terminal
      .command("send-keys")
      .description("Send keys to a terminal")
      .argument("<terminal-id>", "Terminal ID, ID prefix, or name")
      .argument("<keys...>", "Keys to send")
      .option("-l, --literal", "Send raw keys without interpreting special tokens")
      .option("--json", "Output in JSON format"),
  ).action(withGlobalOptions(runSendKeysCommand));

  return terminal;
}
