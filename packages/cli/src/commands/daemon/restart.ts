import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'

/** Result of restart command */
interface RestartResult {
  action: 'restarted' | 'not_running'
  host: string
  message: string
}

/** Schema for restart result */
const restartResultSchema: OutputSchema<RestartResult> = {
  idField: 'action',
  columns: [
    {
      header: 'STATUS',
      field: 'action',
      color: (value) => (value === 'restarted' ? 'green' : 'red'),
    },
    { header: 'HOST', field: 'host' },
    { header: 'MESSAGE', field: 'message' },
  ],
}

export type RestartCommandResult = SingleResult<RestartResult>

export async function runRestartCommand(
  options: CommandOptions,
  _command: Command
): Promise<RestartCommandResult> {
  const connectOptions = { host: options.host as string | undefined }
  const host = getDaemonHost(connectOptions)

  let client
  try {
    client = await connectToDaemon(connectOptions)
  } catch {
    // Daemon not running - cannot restart
    const error: CommandError = {
      code: 'DAEMON_NOT_RUNNING',
      message: `Daemon is not running (tried to connect to ${host})`,
      details: 'Start the daemon with: paseo daemon start',
    }
    throw error
  }

  try {
    // Request server restart
    await client.restartServer('cli_restart')

    await client.close()

    return {
      type: 'single',
      data: {
        action: 'restarted',
        host,
        message: 'Daemon restart requested',
      },
      schema: restartResultSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)

    // If connection was closed, the daemon is restarting
    if (message.includes('closed') || message.includes('disconnected')) {
      return {
        type: 'single',
        data: {
          action: 'restarted',
          host,
          message: 'Daemon is restarting',
        },
        schema: restartResultSchema,
      }
    }

    const error: CommandError = {
      code: 'RESTART_FAILED',
      message: `Failed to restart daemon: ${message}`,
    }
    throw error
  }
}
