import { Command } from "commander";
import { startCommand } from "./start.js";
import { runStatusCommand } from "./status.js";
import { runStopCommand } from "./stop.js";
import { runRestartCommand } from "./restart.js";
import { pairCommand } from "./pair.js";
import { withOutput } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";

export function createDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the Paseo daemon");

  daemon.addCommand(startCommand());
  daemon.addCommand(pairCommand());

  addJsonOption(daemon.command("status").description("Show local daemon status"))
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .action(withOutput(runStatusCommand));

  addJsonOption(daemon.command("stop").description("Stop the local daemon"))
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .option("--timeout <seconds>", "Wait timeout before failing (default: 15)")
    .option("--force", "Send SIGKILL if graceful stop times out")
    .action(withOutput(runStopCommand));

  addJsonOption(daemon.command("restart").description("Restart the local daemon"))
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .option("--timeout <seconds>", "Wait timeout before force step (default: 15)")
    .option("--force", "Send SIGKILL if graceful stop times out")
    .option(
      "--listen <listen>",
      "Listen target for restarted daemon (host:port, port, or unix socket)",
    )
    .option("--port <port>", "Port for restarted daemon listen target")
    .option("--no-relay", "Disable relay on restarted daemon")
    .option("--no-mcp", "Disable Agent MCP on restarted daemon")
    .option("--no-inject-mcp", "Disable auto-injecting the Paseo MCP into created agents")
    .option(
      "--allowed-hosts <hosts>",
      'Comma-separated Host allowlist values (example: "localhost,.example.com" or "true")',
    )
    .action(withOutput(runRestartCommand));

  return daemon;
}
