import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost, resolveAgentId } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'

/** Result type for agent stop command */
export interface StopResult {
  stoppedCount: number
  agentIds: string[]
}

/** Schema for stop command output */
export const stopSchema: OutputSchema<StopResult> = {
  // For quiet mode, output the stopped agent IDs (one per line)
  idField: (item) => item.agentIds.join('\n'),
  columns: [{ header: 'STOPPED', field: 'stoppedCount' }],
}

export interface AgentStopOptions extends CommandOptions {
  all?: boolean
  cwd?: string
}

export type AgentStopResult = SingleResult<StopResult>

export async function runStopCommand(
  id: string | undefined,
  options: AgentStopOptions,
  _command: Command
): Promise<AgentStopResult> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  // Validate arguments - need either an id, --all, or --cwd
  if (!id && !options.all && !options.cwd) {
    const error: CommandError = {
      code: 'MISSING_ARGUMENT',
      message: 'Agent ID required unless --all or --cwd is specified',
      details: 'Usage: paseo agent stop <id> | --all | --cwd <path>',
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
    // Request session state to get agent information
    client.requestSessionState()

    // Wait a moment for the session state to be populated
    await new Promise((resolve) => setTimeout(resolve, 500))

    let agents = client.listAgents()
    const stoppedIds: string[] = []

    if (options.all) {
      // Stop all agents (not archived)
      agents = agents.filter((a) => !a.archivedAt)
    } else if (options.cwd) {
      // Stop agents in directory
      const filterCwd = options.cwd
      agents = agents.filter((a) => {
        if (a.archivedAt) return false
        const agentCwd = a.cwd.replace(/\/$/, '')
        const targetCwd = filterCwd.replace(/\/$/, '')
        return agentCwd === targetCwd || agentCwd.startsWith(targetCwd + '/')
      })
    } else if (id) {
      // Stop specific agent
      const resolvedId = resolveAgentId(id, agents)
      if (!resolvedId) {
        const error: CommandError = {
          code: 'AGENT_NOT_FOUND',
          message: `No agent found matching: ${id}`,
          details: 'Use `paseo agent ps` to list available agents',
        }
        throw error
      }
      agents = agents.filter((a) => a.id === resolvedId)
    }

    // Stop each agent
    for (const agent of agents) {
      try {
        // Cancel if running
        if (agent.status === 'running') {
          await client.cancelAgent(agent.id)
        }
        // Delete the agent
        await client.deleteAgent(agent.id)
        stoppedIds.push(agent.id)
      } catch (err) {
        // Continue stopping other agents even if one fails
        const message = err instanceof Error ? err.message : String(err)
        console.error(`Warning: Failed to stop agent ${agent.id.slice(0, 7)}: ${message}`)
      }
    }

    await client.close()

    return {
      type: 'single',
      data: {
        stoppedCount: stoppedIds.length,
        agentIds: stoppedIds,
      },
      schema: stopSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})
    // Re-throw if it's already a CommandError
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'STOP_AGENT_FAILED',
      message: `Failed to stop agent(s): ${message}`,
    }
    throw error
  }
}
