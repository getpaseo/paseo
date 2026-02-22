import { Command } from 'commander'
import { startCommand } from './start.js'
import { runStatusCommand } from './status.js'
import { runStopCommand } from './stop.js'
import { runRestartCommand } from './restart.js'
import { pairCommand } from './pair.js'
import { updateCommand } from './update.js'
import { withOutput } from '../../output/index.js'

export function createDaemonCommand(): Command {
  const daemon = new Command('daemon').description('Manage the Paseo daemon')

  daemon.addCommand(startCommand())
  daemon.addCommand(pairCommand())
  daemon.addCommand(updateCommand())

  daemon
    .command('status')
    .description('Show local daemon status')
    .option('--json', 'Output in JSON format')
    .option('--home <path>', 'Paseo home directory (default: ~/.paseo)')
    .action(withOutput(runStatusCommand))

  daemon
    .command('stop')
    .description('Stop the local daemon')
    .option('--json', 'Output in JSON format')
    .option('--home <path>', 'Paseo home directory (default: ~/.paseo)')
    .option('--timeout <seconds>', 'Wait timeout before failing (default: 15)')
    .option('--force', 'Send SIGKILL if graceful stop times out')
    .action(withOutput(runStopCommand))

  daemon
    .command('restart')
    .description('Restart the local daemon')
    .option('--json', 'Output in JSON format')
    .option('--home <path>', 'Paseo home directory (default: ~/.paseo)')
    .option('--timeout <seconds>', 'Wait timeout before force step (default: 15)')
    .option('--force', 'Send SIGKILL if graceful stop times out')
    .option('--listen <listen>', 'Listen target for restarted daemon (host:port, port, or unix socket)')
    .option('--port <port>', 'Port for restarted daemon listen target')
    .option('--no-relay', 'Disable relay on restarted daemon')
    .option('--no-mcp', 'Disable Agent MCP on restarted daemon')
    .option(
      '--allowed-hosts <hosts>',
      'Comma-separated Host allowlist values (example: "localhost,.example.com" or "true")'
    )
    .action(withOutput(runRestartCommand))

  return daemon
}
