import { Command } from 'commander'
import { runLsCommand } from './ls.js'
import { runArchiveCommand } from './archive.js'
import { withOutput } from '../../output/index.js'

export function createWorktreeCommand(): Command {
  const worktree = new Command('worktree').description('Manage Junction-managed git worktrees')

  worktree
    .command('ls')
    .description('List Junction-managed git worktrees')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runLsCommand))

  worktree
    .command('archive')
    .description('Archive a worktree (removes worktree and associated branch)')
    .argument('<name>', 'Worktree name or branch name')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runArchiveCommand))

  return worktree
}
