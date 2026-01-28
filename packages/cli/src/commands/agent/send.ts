import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'

/** Minimal agent snapshot type (from daemon client) */
interface AgentSnapshot {
  id: string
  provider: string
  cwd: string
  createdAt: string
  status: string
  title: string | null
}

/** Result type for agent send command */
export interface AgentSendResult {
  agentId: string
  status: 'sent' | 'completed'
  message: string
}

/** Schema for agent send output */
export const agentSendSchema: OutputSchema<AgentSendResult> = {
  idField: 'agentId',
  columns: [
    { header: 'AGENT ID', field: 'agentId', width: 12 },
    { header: 'STATUS', field: 'status', width: 12 },
    { header: 'MESSAGE', field: 'message', width: 40 },
  ],
}

export interface AgentSendOptions extends CommandOptions {
  noWait?: boolean
}

/**
 * Resolve agent ID from prefix or full ID.
 * Supports exact match and prefix matching.
 */
function resolveAgentId(agents: AgentSnapshot[], idOrPrefix: string): string | null {
  // Exact match first
  const exact = agents.find((a) => a.id === idOrPrefix)
  if (exact) return exact.id

  // Prefix match
  const matches = agents.filter((a) => a.id.startsWith(idOrPrefix))
  if (matches.length === 1 && matches[0]) return matches[0].id
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix '${idOrPrefix}': matches ${matches.length} agents (${matches.map((a) => a.id.slice(0, 7)).join(', ')})`
    )
  }

  return null
}

export async function runSendCommand(
  agentIdArg: string,
  prompt: string,
  options: AgentSendOptions,
  _command: Command
): Promise<SingleResult<AgentSendResult>> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: 'MISSING_AGENT_ID',
      message: 'Agent ID is required',
      details: 'Usage: paseo agent send [options] <id> <prompt>',
    }
    throw error
  }

  if (!prompt || prompt.trim().length === 0) {
    const error: CommandError = {
      code: 'MISSING_PROMPT',
      message: 'A prompt is required',
      details: 'Usage: paseo agent send [options] <id> <prompt>',
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

    const agents = client.listAgents()

    // Resolve agent ID (supports prefix matching)
    const agentId = resolveAgentId(agents, agentIdArg)
    if (!agentId) {
      const error: CommandError = {
        code: 'AGENT_NOT_FOUND',
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo agent ps" to list available agents',
      }
      throw error
    }

    // Send the message
    await client.sendAgentMessage(agentId, prompt)

    // If --no-wait, return immediately
    if (options.noWait) {
      await client.close()

      return {
        type: 'single',
        data: {
          agentId,
          status: 'sent',
          message: 'Message sent, not waiting for completion',
        },
        schema: agentSendSchema,
      }
    }

    // Wait for agent to become idle
    await client.waitForAgentIdle(agentId, 600000) // 10 minute timeout

    await client.close()

    return {
      type: 'single',
      data: {
        agentId,
        status: 'completed',
        message: 'Agent completed processing the message',
      },
      schema: agentSendSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})

    // Re-throw CommandError as-is
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }

    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'SEND_FAILED',
      message: `Failed to send message: ${message}`,
    }
    throw error
  }
}
