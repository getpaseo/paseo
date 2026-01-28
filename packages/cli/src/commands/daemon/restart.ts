import { Command } from 'commander'
import chalk from 'chalk'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'

export function restartCommand(): Command {
  return new Command('restart')
    .description('Restart the daemon')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(async (options: { host?: string }) => {
      await runRestart(options)
    })
}

async function runRestart(options: { host?: string }): Promise<void> {
  const host = getDaemonHost(options)

  let client
  try {
    client = await connectToDaemon(options)
  } catch {
    console.log(chalk.yellow('Daemon is not running'))
    console.log(chalk.dim(`Tried to connect to ${host}`))
    console.log()
    console.log(chalk.dim('Start the daemon with:'))
    console.log(chalk.dim('  paseo daemon start'))
    process.exit(1)
  }

  try {
    console.log(chalk.dim('Restarting daemon...'))

    // Request server restart
    await client.restartServer('cli_restart')

    console.log(chalk.green('Daemon restart requested'))

    await client.close()
  } catch (err) {
    await client.close().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)

    // If connection was closed, the daemon is restarting
    if (message.includes('closed') || message.includes('disconnected')) {
      console.log(chalk.green('Daemon is restarting'))
      process.exit(0)
    }

    console.error(chalk.red(`Failed to restart daemon: ${message}`))
    process.exit(1)
  }
}
