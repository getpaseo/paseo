import { Command } from 'commander'
import { startCommand } from './start.js'
import { statusCommand } from './status.js'
import { stopCommand } from './stop.js'
import { restartCommand } from './restart.js'

export function createDaemonCommand(): Command {
  const daemon = new Command('daemon')
    .description('Manage the Paseo daemon')

  daemon.addCommand(startCommand())
  daemon.addCommand(statusCommand())
  daemon.addCommand(stopCommand())
  daemon.addCommand(restartCommand())

  return daemon
}
