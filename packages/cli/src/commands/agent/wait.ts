import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'

/** Result type for agent wait command */
export interface AgentWaitResult {
  agentId: string
  status: 'idle' | 'timeout' | 'permission' | 'error'
  message: string
}

/** Schema for agent wait output */
export const agentWaitSchema: OutputSchema<AgentWaitResult> = {
  idField: 'agentId',
  columns: [
    { header: 'AGENT ID', field: 'agentId', width: 12 },
    { header: 'STATUS', field: 'status', width: 12 },
    { header: 'MESSAGE', field: 'message', width: 40 },
  ],
}

export interface AgentWaitOptions extends CommandOptions {
  timeout?: string
  host?: string
}

/**
 * Parse duration string to milliseconds.
 * Supports formats like: 5m, 30s, 1h, 2h30m, 90, etc.
 * If no unit is specified, assumes seconds.
 */
function parseDuration(input: string): number {
  const trimmed = input.trim()

  // If it's just a number, treat as seconds
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000
  }

  // Parse duration with units
  let totalMs = 0
  const regex = /(\d+)([smh])/g
  let match
  let hasMatch = false

  while ((match = regex.exec(trimmed)) !== null) {
    hasMatch = true
    const value = parseInt(match[1], 10)
    const unit = match[2]

    switch (unit) {
      case 's':
        totalMs += value * 1000
        break
      case 'm':
        totalMs += value * 60 * 1000
        break
      case 'h':
        totalMs += value * 60 * 60 * 1000
        break
    }
  }

  if (!hasMatch) {
    throw new Error(`Invalid duration format: ${input}. Use formats like: 5m, 30s, 1h, 2h30m`)
  }

  return totalMs
}

export async function runWaitCommand(
  agentIdArg: string,
  options: AgentWaitOptions,
  _command: Command
): Promise<SingleResult<AgentWaitResult>> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: 'MISSING_AGENT_ID',
      message: 'Agent ID is required',
      details: 'Usage: paseo agent wait <id>',
    }
    throw error
  }

  // Parse timeout (default 10 minutes)
  let timeoutMs: number
  if (options.timeout) {
    try {
      timeoutMs = parseDuration(options.timeout)
      if (timeoutMs <= 0) {
        throw new Error('Timeout must be positive')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const error: CommandError = {
        code: 'INVALID_TIMEOUT',
        message: 'Invalid timeout value',
        details: message,
      }
      throw error
    }
  } else {
    timeoutMs = 10 * 60 * 1000 // default 10 minutes
  }
  const timeoutSeconds = Math.floor(timeoutMs / 1000)

  let client
  try {
    client = await connectToDaemon({ host: options.host as string | undefined })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'DAEMON_NOT_RUNNING',
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: 'Start the daemon with: paseo daemon start',
    }
    throw error
  }

  try {
    try {
      const state = await client.waitForFinish(agentIdArg, timeoutMs)
      await client.close()

      if (state.status === 'timeout') {
        return {
          type: 'single',
          data: {
            agentId: agentIdArg,
            status: 'timeout',
            message: `Timed out waiting for agent after ${timeoutSeconds} seconds`,
          },
          schema: agentWaitSchema,
        }
      }

      if (state.status === 'permission') {
        const permission = state.final?.pendingPermissions?.[0]
        return {
          type: 'single',
          data: {
            agentId: state.final?.id ?? agentIdArg,
            status: 'permission',
            message: permission
              ? `Agent is waiting for permission: ${permission.kind}`
              : 'Agent is waiting for permission',
          },
          schema: agentWaitSchema,
        }
      }

      if (state.status === 'error') {
        return {
          type: 'single',
          data: {
            agentId: state.final?.id ?? agentIdArg,
            status: 'error',
            message: state.error ?? 'Agent finished with error',
          },
          schema: agentWaitSchema,
        }
      }

      // Agent is idle
      return {
        type: 'single',
        data: {
          agentId: state.final?.id ?? agentIdArg,
          status: 'idle',
          message: 'Agent is now idle',
        },
        schema: agentWaitSchema,
      }
    } catch (waitErr) {
      await client.close().catch(() => {})

      const waitMessage = waitErr instanceof Error ? waitErr.message : String(waitErr)

      // Other errors
      const error: CommandError = {
        code: 'WAIT_FAILED',
        message: `Failed to wait for agent: ${waitMessage}`,
      }
      throw error
    }
  } catch (err) {
    await client.close().catch(() => {})

    // Re-throw CommandError as-is
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }

    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'WAIT_FAILED',
      message: `Failed to wait for agent: ${message}`,
    }
    throw error
  }
}
