import { Command } from 'commander'
import chalk from 'chalk'
import { resolvePaseoHome } from '@paseo/server'
import { tryConnectToDaemon, getDaemonHost } from '../../utils/client.js'

export function statusCommand(): Command {
  return new Command('status')
    .description('Show daemon status')
    .option('--host <host>', 'Daemon host:port (default: localhost:6767)')
    .action(async (options: { host?: string }) => {
      await runStatus(options)
    })
}

async function runStatus(options: { host?: string }): Promise<void> {
  const host = getDaemonHost(options)
  const client = await tryConnectToDaemon(options)

  if (!client) {
    console.log(chalk.red('Status:'), 'not running')
    console.log(chalk.dim(`Tried to connect to ${host}`))
    console.log()
    console.log(chalk.dim('Start the daemon with:'))
    console.log(chalk.dim('  paseo daemon start'))
    process.exit(1)
  }

  try {
    // Request session state to get agent information
    client.requestSessionState()

    // Wait a moment for the session state to be populated
    await new Promise(resolve => setTimeout(resolve, 500))

    const agents = client.listAgents()
    const runningAgents = agents.filter(a => a.status === 'running')
    const idleAgents = agents.filter(a => a.status === 'idle')

    // Get paseo home for display
    const paseoHome = resolvePaseoHome()

    console.log(chalk.green('Status:'), 'running')
    console.log(chalk.dim('Host:'), host)
    console.log(chalk.dim('Home:'), paseoHome)
    console.log(chalk.dim('Agents:'), `${runningAgents.length} running, ${idleAgents.length} idle`)

    await client.close()
  } catch (err) {
    await client.close().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    console.error(chalk.red(`Failed to get status: ${message}`))
    process.exit(1)
  }
}
