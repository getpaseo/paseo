import { Command, Option } from "commander";
import { withOutput } from "./output/with-output.js";
import {
  addDaemonHostOption,
  addJsonAndDaemonHostOptions,
  withGlobalOptions,
} from "./utils/command-options.js";
import { resolveCliVersion } from "./version.js";

const VERSION = resolveCliVersion();

interface CommandManifestEntry {
  readonly name: string;
  readonly args: readonly string[];
  readonly description: string;
  readonly hidden?: boolean;
  readonly load: () => Promise<Command>;
}

const ROOT_VALUE_OPTIONS = new Set(["-o", "--format", "--host", "--home"]);
const ROOT_STOP_FLAGS = new Set(["-v", "--version", "-h", "--help"]);

const COMMAND_MANIFEST: readonly CommandManifestEntry[] = [
  {
    name: "host",
    args: [],
    description: "Manage hosts connected to the selected daemon",
    load: async () => (await import("./commands/host/index.js")).createHostCommand(),
  },
  {
    name: "ls",
    args: [],
    description: "List agents. By default excludes archived agents.",
    load: async () => {
      const { addLsOptions, runLsCommand } = await import("./commands/agent/ls.js");
      return addJsonAndDaemonHostOptions(addLsOptions(new Command("ls"))).action(
        withOutput(runLsCommand),
      );
    },
  },
  {
    name: "run",
    args: ["<prompt>"],
    description: "Create and start an agent with a task",
    load: async () => {
      const { addRunOptions, runRunCommand } = await import("./commands/agent/run.js");
      return addJsonAndDaemonHostOptions(addRunOptions(new Command("run"))).action(
        withOutput(runRunCommand),
      );
    },
  },
  {
    name: "import",
    args: ["<id>"],
    description: "Import an existing provider session as a Paseo agent",
    load: async () => {
      const { addImportOptions, runImportCommand } = await import("./commands/agent/import.js");
      return addJsonAndDaemonHostOptions(addImportOptions(new Command("import"))).action(
        withOutput(runImportCommand),
      );
    },
  },
  {
    name: "clone",
    args: ["<repo>"],
    description: "Clone a GitHub repo and register it as a Paseo workspace",
    load: async () => {
      const { runCloneCommand } = await import("./commands/clone.js");
      return addJsonAndDaemonHostOptions(
        new Command("clone")
          .description("Clone a GitHub repo and register it as a Paseo workspace")
          .argument("<repo>", "GitHub repo in owner/repo format or a full git remote URL")
          .requiredOption(
            "--dir <path>",
            "Parent directory to clone into (for example: ~/workspace)",
          ),
      )
        .addOption(
          new Option(
            "--protocol <protocol>",
            "Protocol for owner/repo shorthand repositories",
          ).choices(["https", "ssh"]),
        )
        .action(withOutput(runCloneCommand));
    },
  },
  {
    name: "attach",
    args: ["<id>"],
    description: "Attach to a running agent's output stream",
    load: async () => {
      const { addAttachOptions, runAttachCommand } = await import("./commands/agent/attach.js");
      return addDaemonHostOption(addAttachOptions(new Command("attach"))).action(
        withGlobalOptions(runAttachCommand),
      );
    },
  },
  {
    name: "logs",
    args: ["<id>"],
    description: "View agent activity/timeline",
    load: async () => {
      const { addLogsOptions, runLogsCommand } = await import("./commands/agent/logs.js");
      return addDaemonHostOption(addLogsOptions(new Command("logs"))).action(
        withGlobalOptions(runLogsCommand),
      );
    },
  },
  {
    name: "stop",
    args: ["[id]"],
    description: "Interrupt an agent if it is running (no-op for idle agents)",
    load: async () => {
      const { addStopOptions, runStopCommand } = await import("./commands/agent/stop.js");
      return addJsonAndDaemonHostOptions(addStopOptions(new Command("stop"))).action(
        withOutput(runStopCommand),
      );
    },
  },
  {
    name: "delete",
    args: ["[id]"],
    description: "Delete an agent (interrupt if running, then hard-delete)",
    load: async () => {
      const { addDeleteOptions, runDeleteCommand } = await import("./commands/agent/delete.js");
      return addJsonAndDaemonHostOptions(addDeleteOptions(new Command("delete"))).action(
        withOutput(runDeleteCommand),
      );
    },
  },
  {
    name: "send",
    args: ["<id>", "[prompt]"],
    description: "Send a message/task to an existing agent",
    load: async () => {
      const { addSendOptions, runSendCommand } = await import("./commands/agent/send.js");
      return addJsonAndDaemonHostOptions(addSendOptions(new Command("send"))).action(
        withOutput(runSendCommand),
      );
    },
  },
  {
    name: "inspect",
    args: ["<id>"],
    description: "Show detailed information about an agent",
    load: async () => {
      const { addInspectOptions, runInspectCommand } = await import("./commands/agent/inspect.js");
      return addJsonAndDaemonHostOptions(addInspectOptions(new Command("inspect"))).action(
        withOutput(runInspectCommand),
      );
    },
  },
  {
    name: "wait",
    args: ["<id>"],
    description: "Wait for an agent to become idle",
    load: async () => {
      const { addWaitOptions, runWaitCommand } = await import("./commands/agent/wait.js");
      return addJsonAndDaemonHostOptions(addWaitOptions(new Command("wait"))).action(
        withOutput(runWaitCommand),
      );
    },
  },
  {
    name: "archive",
    args: ["<id>"],
    description: "Archive an agent (soft-delete)",
    load: async () => {
      const { addArchiveOptions, runArchiveCommand } = await import("./commands/agent/archive.js");
      return addJsonAndDaemonHostOptions(addArchiveOptions(new Command("archive"))).action(
        withOutput(runArchiveCommand),
      );
    },
  },
  {
    name: "onboard",
    args: [],
    description: "Run first-time setup, start daemon, and print pairing instructions",
    load: async () => (await import("./commands/onboard.js")).onboardCommand(),
  },
  {
    name: "start",
    args: [],
    description: "Start the local daemon from persistent configuration (local operation)",
    load: async () => (await import("./commands/daemon/start.js")).startCommand(),
  },
  {
    name: "hooks",
    args: ["<agent>", "<event>"],
    description: "Record agent hook activity",
    load: async () => (await import("./commands/hooks.js")).createHooksCommand(),
  },
  {
    name: "status",
    args: [],
    description: "Observe the selected daemon and its published endpoint",
    load: async () => (await import("./commands/daemon/status.js")).daemonStatusCommand(),
  },
  {
    name: "restart",
    args: [],
    description: "Restart the selected daemon worker, retaining its supervisor launch",
    load: async () => (await import("./commands/daemon/restart.js")).daemonRestartCommand(),
  },
  {
    name: "reload",
    args: [],
    description: "Reload config.json without restarting",
    load: async () => (await import("./commands/daemon/reload.js")).daemonReloadCommand(),
  },
  {
    name: "pair",
    args: [],
    description: "Print the daemon pairing QR code and link",
    load: async () => (await import("./commands/daemon/pair.js")).pairCommand(),
  },
  {
    name: "agent",
    args: [],
    description: "Manage agents (advanced operations)",
    load: async () => (await import("./commands/agent/index.js")).createAgentCommand(),
  },
  {
    name: "daemon",
    args: [],
    description: "Manage the Paseo daemon",
    load: async () => (await import("./commands/daemon/index.js")).createDaemonCommand(),
  },
  {
    name: "hub",
    args: [],
    description: "Manage Paseo Hub",
    load: async () => (await import("./commands/hub/index.js")).createHubCommand(),
  },
  {
    name: "terminal",
    args: [],
    description: "Manage workspace terminals",
    load: async () => (await import("./commands/terminal/index.js")).createTerminalCommand(),
  },
  {
    name: "script",
    args: [],
    description: "Manage configured workspace scripts",
    load: async () => (await import("./commands/script/index.js")).createScriptCommand(),
  },
  {
    name: "schedule",
    args: [],
    description: "Manage recurring schedules",
    load: async () => (await import("./commands/schedule/index.js")).createScheduleCommand(),
  },
  {
    name: "heartbeat",
    args: [],
    description: "Manage this agent's heartbeats",
    load: async () => (await import("./commands/heartbeat/index.js")).createHeartbeatCommand(),
  },
  {
    name: "permit",
    args: [],
    description: "Manage permission requests",
    load: async () => (await import("./commands/permit/index.js")).createPermitCommand(),
  },
  {
    name: "provider",
    args: [],
    description: "Manage agent providers",
    load: async () => (await import("./commands/provider/index.js")).createProviderCommand(),
  },
  {
    name: "usage",
    args: [],
    description: "Show account usage reports",
    load: async () => (await import("./commands/usage/index.js")).createUsageCommand(),
  },
  {
    name: "plugin",
    args: [],
    description: "Manage trusted, unsandboxed plugins",
    load: async () => (await import("./commands/plugin/index.js")).createPluginCommand(),
  },
  {
    name: "speech",
    args: [],
    description: "Speech commands",
    load: async () => (await import("./commands/speech/index.js")).createSpeechCommand(),
  },
  {
    name: "project",
    args: [],
    description: "Manage projects",
    load: async () => (await import("./commands/project/index.js")).createProjectCommand(),
  },
  {
    name: "workspace",
    args: [],
    description: "Manage workspaces",
    load: async () => (await import("./commands/workspace/index.js")).createWorkspaceCommand(),
  },
  // COMPAT(worktreeCli): legacy command alias added before workspace was the product unit.
  // Added in v0.2.0; remove after 2027-01-17.
  {
    name: "worktree",
    args: [],
    description: "Manage Paseo-managed git worktrees",
    hidden: true,
    load: async () => (await import("./commands/worktree/index.js")).createWorktreeCommand(),
  },
];

export const KNOWN_CLI_COMMANDS: ReadonlySet<string> = new Set(
  COMMAND_MANIFEST.map((entry) => entry.name),
);

function createRootProgram(): Command {
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
  addDaemonHostOption(program);
  return program;
}

function createStubCommand(entry: CommandManifestEntry): Command {
  const command = new Command(entry.name).description(entry.description);
  for (const arg of entry.args) {
    command.argument(arg);
  }
  return command;
}

function finalizeProgram(program: Command): Command {
  // Stop root parsing at the command so `plugin update --version` belongs to update.
  // Keep global options available after a command, as they were before positional parsing.
  program.enablePositionalOptions();
  for (const command of program.commands) {
    for (const option of program.options) {
      if (option.long === "--version") continue;
      if (!command.options.some((local) => local.long === option.long)) command.addOption(option);
      if (option.long === "--home" || option.long === "--host") continue;
      command.on(`option:${option.name()}`, () => {
        const key = option.attributeName();
        program.setOptionValueWithSource(key, command.opts()[key], "cli");
      });
    }
    if (command.name() !== "plugin")
      command.version(VERSION, "-v, --version", "output the version number");
  }

  const enforceSelectorDuplicates = (command: Command) => {
    for (const option of command.options) {
      if (option.long !== "--home" && option.long !== "--host") continue;
      option.argParser((value: string, previous: string | undefined) => {
        if (previous !== undefined && previous !== value)
          throw {
            code: "TARGET_AMBIGUOUS",
            message: `Conflicting duplicate ${option.long} selectors.`,
          };
        return value;
      });
    }
    command.commands.forEach(enforceSelectorDuplicates);
  };
  enforceSelectorDuplicates(program);
  return program;
}

/**
 * Identify the single top-level command referenced by `cliArgv` (skipping root flags
 * and resolving `help <command>`) so runtime execution only imports that command's module.
 */
export function resolveTargetCommandName(cliArgv: readonly string[]): string | null {
  for (let index = 0; index < cliArgv.length; index += 1) {
    const token = cliArgv[index];
    if (token === undefined || token === "--") return null;
    if (ROOT_STOP_FLAGS.has(token)) return null;
    if (ROOT_VALUE_OPTIONS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;

    if (token === "help") {
      const next = cliArgv[index + 1];
      return next && KNOWN_CLI_COMMANDS.has(next) ? next : null;
    }
    return KNOWN_CLI_COMMANDS.has(token) ? token : null;
  }
  return null;
}

/**
 * Build the CLI program for a single invocation, eagerly registering only lightweight
 * stubs for unmatched commands and dynamically importing only the matched command.
 */
export async function createCliForArgv(cliArgv: readonly string[]): Promise<Command> {
  const program = createRootProgram();
  const targetName = resolveTargetCommandName(cliArgv);

  for (const entry of COMMAND_MANIFEST) {
    const command = entry.name === targetName ? await entry.load() : createStubCommand(entry);
    if (entry.hidden) {
      program.addCommand(command, { hidden: true });
    } else {
      program.addCommand(command);
    }
  }

  return finalizeProgram(program);
}

/**
 * Build the complete CLI command tree with every command hydrated.
 * Used by surface tests that inspect options and subcommands across all commands.
 */
export async function createCli(): Promise<Command> {
  const program = createRootProgram();
  const commands = await Promise.all(COMMAND_MANIFEST.map((entry) => entry.load()));

  for (let index = 0; index < COMMAND_MANIFEST.length; index += 1) {
    const entry = COMMAND_MANIFEST[index]!;
    const command = commands[index]!;
    if (entry.hidden) {
      program.addCommand(command, { hidden: true });
    } else {
      program.addCommand(command);
    }
  }

  return finalizeProgram(program);
}
