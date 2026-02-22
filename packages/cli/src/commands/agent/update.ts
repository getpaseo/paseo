import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'

/** Result type for agent update command */
export interface AgentUpdateResult {
  agentId: string
  name: string | null
  labels: string
}

/** Schema for update command output */
export const updateSchema: OutputSchema<AgentUpdateResult> = {
  idField: 'agentId',
  columns: [
    { header: 'AGENT ID', field: 'agentId' },
    { header: 'NAME', field: 'name' },
    { header: 'LABELS', field: 'labels' },
  ],
}

export interface AgentUpdateOptions extends CommandOptions {
  name?: string
  label?: string[]
  host?: string
}

export type AgentUpdateCommandResult = SingleResult<AgentUpdateResult>

function parseLabelOptions(labels: string[] | undefined): Record<string, string> {
  const parsed: Record<string, string> = {}
  if (!labels) {
    return parsed
  }

  for (const rawLabel of labels) {
    for (const segment of rawLabel.split(',')) {
      const label = segment.trim()
      if (!label) {
        continue
      }

      const eqIndex = label.indexOf('=')
      if (eqIndex === -1) {
        const error: CommandError = {
          code: 'INVALID_LABEL',
          message: `Invalid label format: ${label}`,
          details: 'Labels must be in key=value format',
        }
        throw error
      }

      const key = label.slice(0, eqIndex).trim()
      const value = label.slice(eqIndex + 1)
      if (!key) {
        const error: CommandError = {
          code: 'INVALID_LABEL',
          message: `Invalid label format: ${label}`,
          details: 'Labels must include a non-empty key in key=value format',
        }
        throw error
      }

      parsed[key] = value
    }
  }

  return parsed
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels)
  if (entries.length === 0) {
    return '-'
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(',')
}

export async function runUpdateCommand(
  agentIdArg: string,
  options: AgentUpdateOptions,
  _command: Command
): Promise<AgentUpdateCommandResult> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: 'MISSING_AGENT_ID',
      message: 'Agent ID is required',
      details: 'Usage: paseo agent update <id> [--name <name>] [--label <key=value>]',
    }
    throw error
  }

  const name = options.name?.trim()
  if (options.name !== undefined && !name) {
    const error: CommandError = {
      code: 'INVALID_NAME',
      message: 'Name cannot be empty',
      details: 'Use --name <name> with a non-empty value',
    }
    throw error
  }

  const labels = parseLabelOptions(options.label)
  if (!name && Object.keys(labels).length === 0) {
    const error: CommandError = {
      code: 'NO_CHANGES_PROVIDED',
      message: 'Nothing to update',
      details: 'Provide at least one of: --name <name>, --label <key=value>',
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
    const fetchResult = await client.fetchAgent(agentIdArg)
    if (!fetchResult) {
      const error: CommandError = {
        code: 'AGENT_NOT_FOUND',
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls" to list available agents',
      }
      throw error
    }
    const agentId = fetchResult.agent.id

    await client.updateAgent(agentId, {
      ...(name ? { name } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    })

    const updatedResult = await client.fetchAgent(agentId)
    if (!updatedResult) {
      throw new Error(`Agent not found after update: ${agentId}`)
    }

    await client.close()

    return {
      type: 'single',
      data: {
        agentId,
        name: updatedResult.agent.title,
        labels: formatLabels(updatedResult.agent.labels),
      },
      schema: updateSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})

    // Re-throw CommandError as-is
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }

    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'UPDATE_FAILED',
      message: `Failed to update agent: ${message}`,
    }
    throw error
  }
}
