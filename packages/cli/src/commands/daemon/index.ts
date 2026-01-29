import { Command } from 'commander'
import { startCommand } from './start.js'
import { runStatusCommand } from './status.js'
import { runStopCommand } from './stop.js'
import { runRestartCommand } from './restart.js'
import { withOutput } from '../../output/index.js'

export function createDaemonCommand(): Command {
  const daemon = new Command('daemon').description('Manage the Paseo daemon')

  daemon.addCommand(startCommand())

  daemon
    .command('status')
    .description('Show daemon status')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action((options, command) => {
      if (options.json) {
        command.parent.parent.opts().format = 'json'
      }
      return withOutput(runStatusCommand)(options, command)
    })

  daemon
    .command('stop')
    .description('Stop the daemon')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runStopCommand))

  daemon
    .command('restart')
    .description('Restart the daemon')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runRestartCommand))

  return daemon
}
