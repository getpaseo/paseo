import { Command } from 'commander'
import { runPsCommand } from './ps.js'
import { runRunCommand } from './run.js'
import { runSendCommand } from './send.js'
import { withOutput } from '../../output/index.js'

export function createAgentCommand(): Command {
  const agent = new Command('agent').description('Manage agents')

  agent
    .command('ps')
    .description('List agents')
    .option('-a, --all', 'include archived agents')
    .option('--status <status>', 'filter by status (running, idle, error)')
    .option('--cwd <path>', 'filter by working directory')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runPsCommand))

  agent
    .command('run')
    .description('Create and start an agent with a task')
    .argument('<prompt>', 'The task/prompt for the agent')
    .option('-d, --detach', 'Run in background (detached)')
    .option('--name <name>', 'Assign a name/title to the agent')
    .option('--provider <provider>', 'Agent provider: claude | codex | opencode', 'claude')
    .option('--mode <mode>', 'Provider-specific mode (e.g., plan, default, bypass)')
    .option('--cwd <path>', 'Working directory (default: current)')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runRunCommand))

  agent
    .command('send')
    .description('Send a message/task to an existing agent')
    .argument('<id>', 'Agent ID (or prefix)')
    .argument('<prompt>', 'The message to send')
    .option('--no-wait', 'Return immediately without waiting for completion')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runSendCommand))

  return agent
}
