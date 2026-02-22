import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type {
  CommandOptions,
  OutputSchema,
  CommandError,
  AnyCommandResult,
} from '../../output/index.js'
import type { AgentMode } from '@getpaseo/server'

/** Result for setting mode */
export interface SetModeResult {
  agentId: string
  mode: string
}

/** Schema for mode list output */
export const modeListSchema: OutputSchema<AgentMode> = {
  idField: 'id',
  columns: [
    { header: 'MODE', field: 'id', width: 15 },
    { header: 'LABEL', field: 'label', width: 25 },
    { header: 'DESCRIPTION', field: 'description', width: 40 },
  ],
}

/** Schema for set mode output */
export const setModeSchema: OutputSchema<SetModeResult> = {
  idField: 'agentId',
  columns: [
    { header: 'AGENT ID', field: 'agentId', width: 12 },
    { header: 'MODE', field: 'mode', width: 20 },
  ],
}

export interface AgentModeOptions extends CommandOptions {
  list?: boolean
}

const missingModeError = (): CommandError => ({
  code: 'MISSING_ARGUMENT',
  message: 'Mode argument required unless --list is specified',
  details: 'Usage: paseo agent mode <id> <mode> | paseo agent mode --list <id>',
})

// This command returns two different data shapes (set result vs mode list).
// Keep `any` here to match the existing output wrapper generic contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentModeResult = AnyCommandResult<any>

export async function runModeCommand(
  id: string,
  mode: string | undefined,
  options: AgentModeOptions,
  _command: Command
): Promise<AgentModeResult> {
  const normalizedMode = mode?.trim()
  const host = getDaemonHost({ host: options.host as string | undefined })

  // Validate arguments
  if (!options.list && !normalizedMode) {
    throw missingModeError()
  }

  let client: Awaited<ReturnType<typeof connectToDaemon>> | undefined
  try {
    client = await connectToDaemon({ host: options.host as string | undefined })
    const fetchResult = await client.fetchAgent(id)
    if (!fetchResult) {
      const error: CommandError = {
        code: 'AGENT_NOT_FOUND',
        message: `No agent found matching: ${id}`,
        details: 'Use `paseo ls` to list available agents',
      }
      throw error
    }
    const agent = fetchResult.agent
    const resolvedId = agent.id

    if (options.list) {
      // List available modes for this agent
      const availableModes = agent.availableModes ?? []

      const items: AgentMode[] = availableModes.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
      }))

      return {
        type: 'list',
        data: items,
        schema: modeListSchema,
      }
    }

    if (!normalizedMode) {
      throw missingModeError()
    }

    // Set the agent mode
    await client.setAgentMode(resolvedId, normalizedMode)

    return {
      type: 'single',
      data: {
        agentId: resolvedId.slice(0, 7),
        mode: normalizedMode,
      },
      schema: setModeSchema,
    }
  } catch (err) {
    // Re-throw if it's already a CommandError
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }

    if (!client) {
      const message = err instanceof Error ? err.message : String(err)
      const error: CommandError = {
        code: 'DAEMON_NOT_RUNNING',
        message: `Cannot connect to daemon at ${host}: ${message}`,
        details: 'Start the daemon with: paseo daemon start',
      }
      throw error
    }

    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'MODE_OPERATION_FAILED',
      message: `Failed to ${options.list ? 'list modes' : 'set mode'}: ${message}`,
    }
    throw error
  } finally {
    if (client) {
      await client.close().catch(() => {})
    }
  }
}
