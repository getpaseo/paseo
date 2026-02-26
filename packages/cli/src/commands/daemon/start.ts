import { Command } from 'commander'
import chalk from 'chalk'
import {
  startLocalDaemonForeground,
  startLocalDaemonDetached,
  type DaemonStartOptions as StartOptions,
} from './local-daemon.js'
import { getErrorMessage } from '../../utils/errors.js'

export type { DaemonStartOptions as StartOptions } from './local-daemon.js'

export function startCommand(): Command {
  return new Command('start')
    .description('Start the local Junction daemon')
    .option('--listen <listen>', 'Listen target (host:port, port, or unix socket path)')
    .option('--port <port>', 'Port to listen on (default: 6767)')
    .option('--home <path>', 'Junction home directory (default: ~/.junction)')
    .option('--foreground', 'Run in foreground (don\'t daemonize)')
    .option('--no-relay', 'Disable relay connection')
    .option('--no-mcp', 'Disable the Agent MCP HTTP endpoint')
    .option(
      '--allowed-hosts <hosts>',
      'Comma-separated Host allowlist values (example: "localhost,.example.com" or "true")'
    )
    .action(async (options: StartOptions) => {
      await runStart(options)
    })
}

export async function runStart(options: StartOptions): Promise<void> {
  if (options.listen && options.port) {
    console.error(chalk.red('Cannot use --listen and --port together'))
    process.exit(1)
  }

  if (!options.foreground) {
    try {
      const startup = await startLocalDaemonDetached(options)
      console.log(chalk.green(`Daemon starting in background (PID ${startup.pid ?? 'unknown'}).`))
      console.log(chalk.dim(`Logs: ${startup.logPath}`))
    } catch (err) {
      exitWithError(getErrorMessage(err))
    }
    return
  }
  try {
    const status = startLocalDaemonForeground(options)
    process.exit(status)
  } catch (err) {
    const message = getErrorMessage(err)
    exitWithError(`Failed to start daemon: ${message}`)
  }
}

function exitWithError(message: string): never {
  console.error(chalk.red(message))
  process.exit(1)
}
