import type { Command } from 'commander'
import { stopLocalDaemon, DEFAULT_STOP_TIMEOUT_MS, type StopLocalDaemonResult } from './local-daemon.js'
import type { CommandOptions, SingleResult, ListResult, OutputSchema, CommandError } from '../../output/index.js'

interface StopResult {
  action: 'stopped' | 'not_running'
  home: string
  pid: string
  message: string
}

const stopResultSchema: OutputSchema<StopResult> = {
  idField: 'action',
  columns: [
    {
      header: 'STATUS',
      field: 'action',
      color: (value) => (value === 'stopped' ? 'green' : 'yellow'),
    },
    { header: 'HOME', field: 'home' },
    { header: 'PID', field: 'pid' },
    { header: 'MESSAGE', field: 'message' },
  ],
}

export type StopCommandResult = SingleResult<StopResult> | ListResult<StopResult>

function parseTimeoutMs(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return DEFAULT_STOP_TIMEOUT_MS
  }

  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    const error: CommandError = {
      code: 'INVALID_TIMEOUT',
      message: `Invalid timeout value: ${raw}`,
      details: 'Timeout must be a positive number of seconds',
    }
    throw error
  }

  return Math.ceil(seconds * 1000)
}

function toStopResult(result: StopLocalDaemonResult): StopResult {
  return {
    action: result.action,
    home: result.home,
    pid: result.pid === null ? '-' : String(result.pid),
    message: result.message,
  }
}

export async function runStopCommand(
  options: CommandOptions,
  _command: Command
): Promise<StopCommandResult> {
  const home = typeof options.home === 'string' ? options.home : undefined
  const force = options.force === true
  const timeoutMs = parseTimeoutMs(options.timeout)
  const all = options.all === true
  const listen = typeof options.listen === 'string' ? options.listen : undefined
  const port = typeof options.port === 'string' ? options.port : undefined

  try {
    const result = await stopLocalDaemon({ home, force, timeoutMs, all, listen, port })

    if (Array.isArray(result)) {
      return {
        type: 'list',
        data: result.map(toStopResult),
        schema: stopResultSchema,
      }
    }

    return {
      type: 'single',
      data: toStopResult(result),
      schema: stopResultSchema,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'STOP_FAILED',
      message: `Failed to stop local daemon: ${message}`,
    }
    throw error
  }
}
