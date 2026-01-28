import { Command } from 'commander'
import { runPsCommand } from './ps.js'
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

  return agent
}
