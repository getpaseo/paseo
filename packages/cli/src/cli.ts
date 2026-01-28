import { Command } from 'commander'
import { createDaemonCommand } from './commands/daemon/index.js'

const VERSION = '0.1.0'

export function createCli(): Command {
  const program = new Command()

  program
    .name('paseo')
    .description('Paseo CLI - control your AI coding agents from the command line')
    .version(VERSION, '-v, --version', 'output the version number')

  // Placeholder subcommands
  program
    .command('agent')
    .description('Manage agents')
    .action(() => {
      console.log('agent command (not yet implemented)')
    })

  // Real daemon command
  program.addCommand(createDaemonCommand())

  program
    .command('permit')
    .description('Manage permission requests')
    .action(() => {
      console.log('permit command (not yet implemented)')
    })

  program
    .command('worktree')
    .description('Manage git worktrees')
    .action(() => {
      console.log('worktree command (not yet implemented)')
    })

  program
    .command('provider')
    .description('Manage agent providers')
    .action(() => {
      console.log('provider command (not yet implemented)')
    })

  return program
}
