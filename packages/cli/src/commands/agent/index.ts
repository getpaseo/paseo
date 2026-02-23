import { Command } from 'commander'
import { runModeCommand } from './mode.js'
import { runArchiveCommand } from './archive.js'
import { runLsCommand } from './ls.js'
import { runRunCommand } from './run.js'
import { runLogsCommand } from './logs.js'
import { runStopCommand } from './stop.js'
import { runSendCommand } from './send.js'
import { runInspectCommand } from './inspect.js'
import { runWaitCommand } from './wait.js'
import { runAttachCommand } from './attach.js'
import { runUpdateCommand } from './update.js'
import { withOutput } from '../../output/index.js'

export function createAgentCommand(): Command {
  const agent = new Command('agent').description('Manage agents (advanced operations)')

  // Helper function to collect multiple option values into an array
  const collectMultiple = (value: string, previous: string[]): string[] => {
    return previous.concat([value])
  }

  // Primary agent commands (same as top-level)
  agent
    .command('ls')
    .description('List agents. By default excludes archived agents.')
    .option('-a, --all', 'Include archived agents')
    .option('-g, --global', 'Legacy no-op (kept for compatibility)')
    .option('--label <key=value>', 'Filter by label (can be used multiple times)', collectMultiple, [])
    .option('--thinking <id>', 'Filter by thinking option ID')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runLsCommand))

  agent
    .command('run')
    .description('Create and start an agent with a task')
    .argument('<prompt>', 'The task/prompt for the agent')
    .option('-d, --detach', 'Run in background (detached)')
    .option('--name <name>', 'Assign a name/title to the agent')
    .option('--provider <provider>', 'Agent provider: claude | codex | opencode', 'claude')
    .option('--model <model>', 'Model to use (e.g., claude-sonnet-4-20250514, claude-3-5-haiku-20241022)')
    .option('--thinking <id>', 'Thinking option ID to use for this run')
    .option('--mode <mode>', 'Provider-specific mode (e.g., plan, default, bypass)')
    .option('--cwd <path>', 'Working directory (default: current)')
    .option('--label <key=value>', 'Add label(s) to the agent (can be used multiple times)', collectMultiple, [])
    .option('--ui', 'Mark as UI agent (equivalent to --label ui=true)')
    .option('--output-schema <schema>', 'Output JSON matching the provided schema file path or inline JSON schema')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runRunCommand))

  agent
    .command('attach')
    .description("Attach to a running agent's output stream")
    .argument('<id>', 'Agent ID (or prefix)')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(runAttachCommand)

  agent
    .command('logs')
    .description('View agent activity/timeline')
    .argument('<id>', 'Agent ID (or prefix)')
    .option('-f, --follow', 'Follow log output (streaming)')
    .option('--tail <n>', 'Show last n entries')
    .option('--filter <type>', 'Filter by event type (tools, text, errors, permissions)')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(runLogsCommand)

  agent
    .command('stop')
    .description('Stop an agent (cancel if running, then terminate)')
    .argument('[id]', 'Agent ID (or prefix) - optional if --all or --cwd specified')
    .option('--all', 'Stop all agents')
    .option('--cwd <path>', 'Stop all agents in directory')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runStopCommand))

  agent
    .command('send')
    .description('Send a message/task to an existing agent')
    .argument('<id>', 'Agent ID (or prefix)')
    .argument('<prompt>', 'The message to send')
    .option('--no-wait', 'Return immediately without waiting for completion')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runSendCommand))

  agent
    .command('inspect')
    .description('Show detailed information about an agent')
    .argument('<id>', 'Agent ID (or prefix)')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runInspectCommand))

  agent
    .command('wait')
    .description('Wait for an agent to become idle')
    .argument('<id>', 'Agent ID (or prefix)')
    .option('--timeout <seconds>', 'Maximum wait time (default: no limit)')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runWaitCommand))

  // Advanced agent commands (less common operations)
  agent
    .command('mode')
    .description("Change an agent's operational mode")
    .argument('<id>', 'Agent ID (or prefix)')
    .argument('[mode]', 'Mode to set (required unless --list)')
    .option('--list', 'List available modes for this agent')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runModeCommand))

  agent
    .command('archive')
    .description('Archive an agent (soft-delete)')
    .argument('<id>', 'Agent ID (or prefix)')
    .option('--force', 'Force archive running agent (interrupts active run first)')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runArchiveCommand))

  agent
    .command('update')
    .description("Update an agent's metadata")
    .argument('<id>', 'Agent ID (or prefix)')
    .option('--name <name>', "Update the agent's display name")
    .option(
      '--label <label>',
      'Add/set label(s) on the agent (can be used multiple times or comma-separated)',
      collectMultiple,
      []
    )
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runUpdateCommand))

  return agent
}
