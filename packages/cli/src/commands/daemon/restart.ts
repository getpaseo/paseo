import type { Command } from 'commander'
import {
  startLocalDaemonDetached,
  stopLocalDaemon,
  DEFAULT_STOP_TIMEOUT_MS,
  type DaemonStartOptions,
  type StopLocalDaemonResult,
} from './local-daemon.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'

interface RestartResult {
  action: 'restarted'
  home: string
  pid: string
  message: string
}

const restartResultSchema: OutputSchema<RestartResult> = {
  idField: 'action',
  columns: [
    {
      header: 'STATUS',
      field: 'action',
      color: () => 'green',
    },
    { header: 'HOME', field: 'home' },
    { header: 'PID', field: 'pid' },
    { header: 'MESSAGE', field: 'message' },
  ],
}

export type RestartCommandResult = SingleResult<RestartResult>

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

function toStartOptions(options: CommandOptions): DaemonStartOptions {
  const startOptions: DaemonStartOptions = {
    home: typeof options.home === 'string' ? options.home : undefined,
    listen: typeof options.listen === 'string' ? options.listen : undefined,
    port: typeof options.port === 'string' ? options.port : undefined,
    relay: typeof options.relay === 'boolean' ? options.relay : undefined,
    mcp: typeof options.mcp === 'boolean' ? options.mcp : undefined,
    allowedHosts: typeof options.allowedHosts === 'string' ? options.allowedHosts : undefined,
  }

  if (startOptions.listen && startOptions.port) {
    const error: CommandError = {
      code: 'INVALID_OPTIONS',
      message: 'Cannot use --listen and --port together',
    }
    throw error
  }

  return startOptions
}

export async function runRestartCommand(
  options: CommandOptions,
  _command: Command
): Promise<RestartCommandResult> {
  const timeoutMs = parseTimeoutMs(options.timeout)
  const force = options.force === true
  const startOptions = toStartOptions(options)

  try {
    let rawStopResult: StopLocalDaemonResult | StopLocalDaemonResult[]
    try {
      rawStopResult = await stopLocalDaemon({
        home: startOptions.home,
        listen: startOptions.listen,
        port: startOptions.port,
        timeoutMs,
        force,
      })
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes('Timed out waiting for daemon PID')
      if (!force && isTimeout) {
        rawStopResult = await stopLocalDaemon({
          home: startOptions.home,
          listen: startOptions.listen,
          port: startOptions.port,
          timeoutMs,
          force: true,
        })
      } else {
        throw err
      }
    }

    const stopResult = Array.isArray(rawStopResult) ? rawStopResult[0]! : rawStopResult
    const startup = await startLocalDaemonDetached(startOptions)
    const before = stopResult.pid === null ? 'not running' : `PID ${stopResult.pid}`
    const after = startup.pid === null ? 'unknown PID' : `PID ${startup.pid}`

    return {
      type: 'single',
      data: {
        action: 'restarted',
        home: stopResult.home,
        pid: startup.pid === null ? '-' : String(startup.pid),
        message: `Local daemon restarted (${before} -> ${after})`,
      },
      schema: restartResultSchema,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'RESTART_FAILED',
      message: `Failed to restart local daemon: ${message}`,
    }
    throw error
  }
}
