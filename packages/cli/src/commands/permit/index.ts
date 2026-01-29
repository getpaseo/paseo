import { Command } from 'commander'
import { runLsCommand } from './ls.js'
import { runAllowCommand } from './allow.js'
import { runDenyCommand } from './deny.js'
import { withOutput } from '../../output/index.js'

export function createPermitCommand(): Command {
  const permit = new Command('permit').description('Manage permission requests')

  permit
    .command('ls')
    .description('List all pending permissions')
    .option('--json', 'Output in JSON format')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action((options, command) => {
      if (options.json) {
        command.parent.parent.opts().format = 'json'
      }
      return withOutput(runLsCommand)(options, command)
    })

  permit
    .command('allow')
    .description('Allow a permission request')
    .argument('<agent>', 'Agent ID (or prefix)')
    .argument('[req_id]', 'Permission request ID (optional if --all)')
    .option('--all', 'Allow all pending permissions for this agent')
    .option('--input <json>', 'Modified input parameters (JSON)')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runAllowCommand))

  permit
    .command('deny')
    .description('Deny a permission request')
    .argument('<agent>', 'Agent ID (or prefix)')
    .argument('[req_id]', 'Permission request ID (optional if --all)')
    .option('--all', 'Deny all pending permissions for this agent')
    .option('--message <msg>', 'Denial reason message')
    .option('--interrupt', 'Stop agent after denial')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(withOutput(runDenyCommand))

  return permit
}
