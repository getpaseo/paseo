import { Command, Option } from "commander";
import { createRequire } from "node:module";
import { createAgentCommand } from "./commands/agent/index.js";
import { createDaemonCommand } from "./commands/daemon/index.js";
import { createChatCommand } from "./commands/chat/index.js";
import { createLoopCommand } from "./commands/loop/index.js";
import { createPermitCommand } from "./commands/permit/index.js";
import { createProviderCommand } from "./commands/provider/index.js";
import { createScheduleCommand } from "./commands/schedule/index.js";
import { createSpeechCommand } from "./commands/speech/index.js";
import { createTerminalCommand } from "./commands/terminal/index.js";
import { addWeChatLoginOptions, createWeChatCommand } from "./commands/wechat/index.js";
import { runWeChatLoginCommand } from "./commands/wechat/login.js";
import { createWorktreeCommand } from "./commands/worktree/index.js";
import { startCommand as daemonStartCommand } from "./commands/daemon/start.js";
import { runStatusCommand as runDaemonStatusCommand } from "./commands/daemon/status.js";
import { runRestartCommand as runDaemonRestartCommand } from "./commands/daemon/restart.js";
import { addLsOptions, runLsCommand } from "./commands/agent/ls.js";
import { addRunOptions, runRunCommand } from "./commands/agent/run.js";
import { addLogsOptions, runLogsCommand } from "./commands/agent/logs.js";
import { addDeleteOptions, runDeleteCommand } from "./commands/agent/delete.js";
import { addStopOptions, runStopCommand } from "./commands/agent/stop.js";
import { addSendOptions, runSendCommand } from "./commands/agent/send.js";
import { addInspectOptions, runInspectCommand } from "./commands/agent/inspect.js";
import { addWaitOptions, runWaitCommand } from "./commands/agent/wait.js";
import { addArchiveOptions, runArchiveCommand } from "./commands/agent/archive.js";
import { addAttachOptions, runAttachCommand } from "./commands/agent/attach.js";
import { withOutput } from "./output/index.js";
import { onboardCommand } from "./commands/onboard.js";
import {
  addDaemonHostOption,
  addJsonAndDaemonHostOptions,
  addJsonOption,
} from "./utils/command-options.js";

const require = createRequire(import.meta.url);

type CliPackageJson = {
  version?: unknown;
};

function resolveCliVersion(): string {
  const packageJson = require("../package.json") as CliPackageJson;
  if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
    return packageJson.version.trim();
  }
  throw new Error("Unable to resolve @getpaseo/cli version from package.json.");
}

const VERSION = resolveCliVersion();

export function createCli(): Command {
  const program = new Command();

  program
    .name("paseo")
    .description("Paseo CLI - control your AI coding agents from the command line")
    .version(VERSION, "-v, --version", "output the version number")
    // Global output options
    .option("-o, --format <format>", "output format: table, json, yaml", "table")
    .option("--json", "output in JSON format (alias for --format json)")
    .option("-q, --quiet", "minimal output (IDs only)")
    .option("--no-headers", "omit table headers")
    .option("--no-color", "disable colored output");

  // Primary agent commands (top-level)
  addJsonAndDaemonHostOptions(addLsOptions(program.command("ls"))).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(addRunOptions(program.command("run"))).action(
    withOutput(runRunCommand),
  );

  addDaemonHostOption(addAttachOptions(program.command("attach"))).action(runAttachCommand);

  addDaemonHostOption(addLogsOptions(program.command("logs"))).action(runLogsCommand);

  addJsonAndDaemonHostOptions(addStopOptions(program.command("stop"))).action(
    withOutput(runStopCommand),
  );

  addJsonAndDaemonHostOptions(addDeleteOptions(program.command("delete"))).action(
    withOutput(runDeleteCommand),
  );

  addJsonAndDaemonHostOptions(addSendOptions(program.command("send"))).action(
    withOutput(runSendCommand),
  );

  addJsonAndDaemonHostOptions(addInspectOptions(program.command("inspect"))).action(
    withOutput(runInspectCommand),
  );

  addJsonAndDaemonHostOptions(addWaitOptions(program.command("wait"))).action(
    withOutput(runWaitCommand),
  );

  addJsonAndDaemonHostOptions(addArchiveOptions(program.command("archive"))).action(
    withOutput(runArchiveCommand),
  );

  // Top-level local daemon shortcuts
  program.addCommand(onboardCommand());
  program.addCommand(daemonStartCommand());

  addJsonOption(
    program
      .command("status")
      .description('Show local daemon status (alias for "paseo daemon status")'),
  )
    .option("--home <path>", "Paseo home directory (default: ~/.paseo)")
    .action(withOutput(runDaemonStatusCommand));

  addJsonOption(
    program
      .command("restart")
      .description('Restart local daemon (alias for "paseo daemon restart")'),
  )
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
    .option(
      "--hostnames <hosts>",
      'Daemon hostnames (comma-separated, e.g. "myhost,.example.com" or "true" for any)',
    )
    .addOption(new Option("--allowed-hosts <hosts>").hideHelp())
    .action(
      withOutput((...args) => {
        const [options, command] = args.slice(-2) as [(typeof args)[number], Command];
        return runDaemonRestartCommand(
          {
            ...options,
            hostnames:
              typeof options.hostnames === "string"
                ? options.hostnames
                : typeof options.allowedHosts === "string"
                  ? options.allowedHosts
                  : undefined,
          },
          command,
        );
      }),
    );

  // Advanced agent commands (less common operations)
  program.addCommand(createAgentCommand());

  // Daemon commands
  program.addCommand(createDaemonCommand());

  // Chat commands
  program.addCommand(createChatCommand());

  // Terminal commands
  program.addCommand(createTerminalCommand());

  // Loop commands
  program.addCommand(createLoopCommand());

  // Schedule commands
  program.addCommand(createScheduleCommand());

  // Permission commands
  program.addCommand(createPermitCommand());

  // Provider commands
  program.addCommand(createProviderCommand());

  // Speech model commands
  program.addCommand(createSpeechCommand());

  // WeChat direct channel commands
  program.addCommand(createWeChatCommand());
  addWeChatLoginOptions(
    program
      .command("wechat-login")
      .description('Show a WeChat QR code in the terminal (alias for "paseo wechat login")'),
  ).action((options, command) => {
    const commandWithGlobals = command as Command & {
      optsWithGlobals?: () => Record<string, unknown>;
    };
    const mergedOptions =
      typeof commandWithGlobals.optsWithGlobals === "function"
        ? {
            ...commandWithGlobals.optsWithGlobals(),
            ...options,
          }
        : options;
    return runWeChatLoginCommand(mergedOptions, command);
  });

  // Worktree commands
  program.addCommand(createWorktreeCommand());

  return program;
}
