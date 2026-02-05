import type { Command } from 'commander'
import { resolvePaseoHome } from '@getpaseo/server'
import { tryConnectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'

/** Status data for the daemon */
interface DaemonStatus {
  status: 'running' | 'stopped'
  host: string
  home: string
  runningAgents: number
  idleAgents: number
}

/** Key-value row for table display */
interface StatusRow {
  key: string
  value: string
}

/** Schema for key-value display with custom serialization for JSON/YAML */
function createStatusSchema(status: DaemonStatus): OutputSchema<StatusRow> {
  return {
    idField: 'key',
    columns: [
      { header: 'KEY', field: 'key' },
      {
        header: 'VALUE',
        field: 'value',
        color: (_, item) => {
          if (item.key === 'Status') {
            return item.value === 'running' ? 'green' : 'red'
          }
          return undefined
        },
      },
    ],
    // For JSON/YAML, return the structured status object (not key-value rows)
    // The serializer receives each item, but we want the whole object
    // So we return null for individual items and handle it at the result level
    serialize: (_item) => status,
  }
}

/** Convert status to key-value rows for table display */
function toStatusRows(status: DaemonStatus): StatusRow[] {
  return [
    { key: 'Status', value: status.status },
    { key: 'Host', value: status.host },
    { key: 'Home', value: status.home },
    { key: 'Agents', value: `${status.runningAgents} running, ${status.idleAgents} idle` },
  ]
}

export type StatusResult = ListResult<StatusRow>

export async function runStatusCommand(
  options: CommandOptions,
  _command: Command
): Promise<StatusResult> {
  const connectOptions = { host: options.host as string | undefined }
  const host = getDaemonHost(connectOptions)
  const client = await tryConnectToDaemon(connectOptions)

  if (!client) {
    const error: CommandError = {
      code: 'DAEMON_NOT_RUNNING',
      message: `Daemon is not running (tried to connect to ${host})`,
      details: 'Start the daemon with: paseo daemon start',
    }
    throw error
  }

  try {
    const agents = await client.fetchAgents()
    const runningAgents = agents.filter((a) => a.status === 'running')
    const idleAgents = agents.filter((a) => a.status === 'idle')

    // Get paseo home for display
    const paseoHome = resolvePaseoHome()

    const status: DaemonStatus = {
      status: 'running',
      host,
      home: paseoHome,
      runningAgents: runningAgents.length,
      idleAgents: idleAgents.length,
    }

    await client.close()

    return {
      type: 'list',
      data: toStatusRows(status),
      schema: createStatusSchema(status),
    }
  } catch (err) {
    await client.close().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'STATUS_FAILED',
      message: `Failed to get status: ${message}`,
    }
    throw error
  }
}
