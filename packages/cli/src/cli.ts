import { Command } from 'commander'
import { createAgentCommand } from './commands/agent/index.js'
import { createDaemonCommand } from './commands/daemon/index.js'
import { createPermitCommand } from './commands/permit/index.js'
import { createProviderCommand } from './commands/provider/index.js'
import { createWorktreeCommand } from './commands/worktree/index.js'
import { runLsCommand } from './commands/agent/ls.js'
import { runRunCommand } from './commands/agent/run.js'
import { runLogsCommand } from './commands/agent/logs.js'
import { runStopCommand } from './commands/agent/stop.js'
import { runSendCommand } from './commands/agent/send.js'
import { runInspectCommand } from './commands/agent/inspect.js'
import { runWaitCommand } from './commands/agent/wait.js'
import { runAttachCommand } from './commands/agent/attach.js'
import { withOutput } from './output/index.js'

const VERSION = '0.1.0'

// Helper function to collect multiple option values into an array
function collectMultiple(value: string, previous: string[]): string[] {
  return previous.concat([value])
}

export function createCli(): Command {
  const program = new Command()

  program
    .name('paseo')
    .description('Paseo CLI - control your AI coding agents from the command line')
    .version(VERSION, '-v, --version', 'output the version number')
    // Global output options
    .option('-o, --format <format>', 'output format: table, json, yaml', 'table')
    .option('--json', 'output in JSON format (alias for --format json)')
    .option('-q, --quiet', 'minimal output (IDs only)')
    .option('--no-headers', 'omit table headers')
    .option('--no-color', 'disable colored output')

  // Primary agent commands (top-level)
  program
    .command('ls')
    .description('List agents. By default shows background agents (without ui=true) in current directory.')
    .option('-a, --all', 'Include all statuses (not just running)')
    .option('-g, --global', 'Show agents from all directories (not just current)')
    .option('--label <key=value>', 'Filter by label (can be used multiple times)', collectMultiple, [])
    .option('--ui', 'Show only UI agents (equivalent to --label ui=true)')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runLsCommand))

  program
    .command('run')
    .description('Create and start an agent with a task')
    .argument('<prompt>', 'The task/prompt for the agent')
    .option('-d, --detach', 'Run in background (detached)')
    .option('--name <name>', 'Assign a name/title to the agent')
    .option('--provider <provider>', 'Agent provider: claude | codex | opencode', 'claude')
    .option('--model <model>', 'Model to use (e.g., claude-sonnet-4-20250514, claude-3-5-haiku-20241022)')
    .option('--mode <mode>', 'Provider-specific mode (e.g., plan, default, bypass)')
    .option('--worktree <name>', 'Create agent in a new git worktree')
    .option('--base <branch>', 'Base branch for worktree (default: current branch)')
    .option('--image <path>', 'Attach image(s) to the initial prompt (can be used multiple times)', collectMultiple, [])
    .option('--cwd <path>', 'Working directory (default: current)')
    .option('--label <key=value>', 'Add label(s) to the agent (can be used multiple times)', collectMultiple, [])
    .option('--ui', 'Mark as UI agent (equivalent to --label ui=true)')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runRunCommand))

  program
    .command('attach')
    .description("Attach to a running agent's output stream")
    .argument('<id>', 'Agent ID (or prefix)')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(runAttachCommand)

  program
    .command('logs')
    .description('View agent activity/timeline')
    .argument('<id>', 'Agent ID (or prefix)')
    .option('-f, --follow', 'Follow log output (streaming)')
    .option('--tail <n>', 'Show last n entries')
    .option('--filter <type>', 'Filter by event type (tools, text, errors, permissions)')
    .option('--since <time>', 'Show logs since timestamp')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(runLogsCommand)

  program
    .command('stop')
    .description('Stop an agent (cancel if running, then terminate)')
    .argument('[id]', 'Agent ID (or prefix) - optional if --all or --cwd specified')
    .option('--all', 'Stop all agents')
    .option('--cwd <path>', 'Stop all agents in directory')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runStopCommand))

  program
    .command('send')
    .description('Send a message/task to an existing agent')
    .argument('<id>', 'Agent ID (or prefix)')
    .argument('<prompt>', 'The message to send')
    .option('--no-wait', 'Return immediately without waiting for completion')
    .option('--image <path>', 'Attach image(s) to the message', collectMultiple, [])
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runSendCommand))

  program
    .command('inspect')
    .description('Show detailed information about an agent')
    .argument('<id>', 'Agent ID (or prefix)')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runInspectCommand))

  program
    .command('wait')
    .description('Wait for an agent to become idle')
    .argument('<id>', 'Agent ID (or prefix)')
    .option('--timeout <seconds>', 'Maximum wait time (default: 600)')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runWaitCommand))

  // Advanced agent commands (less common operations)
  program.addCommand(createAgentCommand())

  // Daemon commands
  program.addCommand(createDaemonCommand())

  // Permission commands
  program.addCommand(createPermitCommand())

  // Provider commands
  program.addCommand(createProviderCommand())

  // Worktree commands
  program.addCommand(createWorktreeCommand())

  return program
}
