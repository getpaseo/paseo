import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'

/** Result of stop command */
interface StopResult {
  action: 'stopped' | 'not_running'
  host: string
  message: string
}

/** Schema for stop result */
const stopResultSchema: OutputSchema<StopResult> = {
  idField: 'action',
  columns: [
    {
      header: 'STATUS',
      field: 'action',
      color: (value) => (value === 'stopped' ? 'green' : 'yellow'),
    },
    { header: 'HOST', field: 'host' },
    { header: 'MESSAGE', field: 'message' },
  ],
}

export type StopCommandResult = SingleResult<StopResult>

export async function runStopCommand(
  options: CommandOptions,
  _command: Command
): Promise<StopCommandResult> {
  const connectOptions = { host: options.host as string | undefined }
  const host = getDaemonHost(connectOptions)

  let client
  try {
    client = await connectToDaemon(connectOptions)
  } catch {
    // Daemon not running - this is a valid outcome
    return {
      type: 'single',
      data: {
        action: 'not_running',
        host,
        message: 'Daemon was not running',
      },
      schema: stopResultSchema,
    }
  }

  try {
    // Request server restart with "shutdown" reason
    // This signals the daemon to shut down gracefully
    await client.restartServer('cli_shutdown')

    // Give the daemon a moment to acknowledge
    await new Promise((resolve) => setTimeout(resolve, 500))

    await client.close()

    return {
      type: 'single',
      data: {
        action: 'stopped',
        host,
        message: 'Daemon stop requested - shutting down gracefully',
      },
      schema: stopResultSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)

    // If connection was closed, the daemon is stopping
    if (message.includes('closed') || message.includes('disconnected')) {
      return {
        type: 'single',
        data: {
          action: 'stopped',
          host,
          message: 'Daemon is stopping',
        },
        schema: stopResultSchema,
      }
    }

    const error: CommandError = {
      code: 'STOP_FAILED',
      message: `Failed to stop daemon: ${message}`,
    }
    throw error
  }
}
