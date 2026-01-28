import { Command } from 'commander'
import chalk from 'chalk'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'

export function stopCommand(): Command {
  return new Command('stop')
    .description('Stop the daemon')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(async (options: { host?: string }) => {
      await runStop(options)
    })
}

async function runStop(options: { host?: string }): Promise<void> {
  const host = getDaemonHost(options)

  let client
  try {
    client = await connectToDaemon(options)
  } catch {
    console.log(chalk.yellow('Daemon is not running'))
    console.log(chalk.dim(`Tried to connect to ${host}`))
    process.exit(0)
  }

  try {
    console.log(chalk.dim('Stopping daemon...'))

    // Request server restart with "shutdown" reason
    // This signals the daemon to shut down gracefully
    await client.restartServer('cli_shutdown')

    // Give the daemon a moment to acknowledge
    await new Promise(resolve => setTimeout(resolve, 500))

    console.log(chalk.green('Daemon stop requested'))
    console.log(chalk.dim('The daemon will shut down gracefully'))

    await client.close()
  } catch (err) {
    await client.close().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)

    // If connection was closed, the daemon is stopping
    if (message.includes('closed') || message.includes('disconnected')) {
      console.log(chalk.green('Daemon is stopping'))
      process.exit(0)
    }

    console.error(chalk.red(`Failed to stop daemon: ${message}`))
    process.exit(1)
  }
}
