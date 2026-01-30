import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost, resolveAgentId } from '../../utils/client.js'
import type {
  CommandOptions,
  OutputSchema,
  CommandError,
  AnyCommandResult,
} from '../../output/index.js'
import type { AgentMode } from '@paseo/server'

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentModeResult = AnyCommandResult<any>

export async function runModeCommand(
  id: string,
  mode: string | undefined,
  options: AgentModeOptions,
  _command: Command
): Promise<AgentModeResult> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  // Validate arguments
  if (!options.list && !mode) {
    const error: CommandError = {
      code: 'MISSING_ARGUMENT',
      message: 'Mode argument required unless --list is specified',
      details: 'Usage: paseo agent mode <id> <mode> | paseo agent mode --list <id>',
    }
    throw error
  }

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
    // Request agent list
    client.requestAgentList()

    // Wait a moment for the agent list to be populated
    await new Promise((resolve) => setTimeout(resolve, 500))

    const agents = client.listAgents()

    // Resolve agent ID
    const resolvedId = resolveAgentId(id, agents)
    if (!resolvedId) {
      const error: CommandError = {
        code: 'AGENT_NOT_FOUND',
        message: `No agent found matching: ${id}`,
        details: 'Use `paseo ls` to list available agents',
      }
      throw error
    }

    const agent = agents.find((a) => a.id === resolvedId)
    if (!agent) {
      const error: CommandError = {
        code: 'AGENT_NOT_FOUND',
        message: `Agent not found after resolution: ${resolvedId}`,
      }
      throw error
    }

    if (options.list) {
      // List available modes for this agent
      const availableModes = agent.availableModes ?? []

      await client.close()

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
    } else {
      // Set the agent mode
      await client.setAgentMode(resolvedId, mode!)

      await client.close()

      return {
        type: 'single',
        data: {
          agentId: resolvedId.slice(0, 7),
          mode: mode!,
        },
        schema: setModeSchema,
      }
    }
  } catch (err) {
    await client.close().catch(() => {})
    // Re-throw if it's already a CommandError
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'MODE_OPERATION_FAILED',
      message: `Failed to ${options.list ? 'list modes' : 'set mode'}: ${message}`,
    }
    throw error
  }
}
