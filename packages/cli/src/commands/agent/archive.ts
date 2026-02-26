import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'

/** Result type for agent archive command */
export interface AgentArchiveResult {
  agentId: string
  status: 'archived'
  archivedAt: string
}

/** Schema for archive command output */
export const archiveSchema: OutputSchema<AgentArchiveResult> = {
  idField: 'agentId',
  columns: [
    { header: 'AGENT ID', field: 'agentId' },
    { header: 'STATUS', field: 'status' },
    { header: 'ARCHIVED AT', field: 'archivedAt' },
  ],
}

export interface AgentArchiveOptions extends CommandOptions {
  force?: boolean
  host?: string
}

export type AgentArchiveCommandResult = SingleResult<AgentArchiveResult>

export async function runArchiveCommand(
  agentIdArg: string,
  options: AgentArchiveOptions,
  _command: Command
): Promise<AgentArchiveCommandResult> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: 'MISSING_AGENT_ID',
      message: 'Agent ID is required',
      details: 'Usage: junction agent archive <id>',
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
      details: 'Start the daemon with: junction daemon start',
    }
    throw error
  }

  try {
    const fetchResult = await client.fetchAgent(agentIdArg)
    if (!fetchResult) {
      const error: CommandError = {
        code: 'AGENT_NOT_FOUND',
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "junction ls" to list available agents',
      }
      throw error
    }
    const agent = fetchResult.agent
    const agentId = agent.id

    // Check if agent is already archived
    if (agent.archivedAt) {
      const error: CommandError = {
        code: 'AGENT_ALREADY_ARCHIVED',
        message: `Agent ${agentId.slice(0, 7)} is already archived`,
        details: `Archived at: ${agent.archivedAt}`,
      }
      throw error
    }

    // Check if agent is running and reject unless --force is set
    if (agent.status === 'running' && !options.force) {
      const error: CommandError = {
        code: 'AGENT_RUNNING',
        message: `Agent ${agentId.slice(0, 7)} is currently running`,
        details:
          'Use --force to archive a running agent (it will interrupt the active run), or stop it first with: junction agent stop',
      }
      throw error
    }

    // Archive the agent
    const result = await client.archiveAgent(agentId)

    await client.close()

    return {
      type: 'single',
      data: {
        agentId,
        status: 'archived',
        archivedAt: result.archivedAt,
      },
      schema: archiveSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})

    // Re-throw CommandError as-is
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }

    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'ARCHIVE_FAILED',
      message: `Failed to archive agent: ${message}`,
    }
    throw error
  }
}
