import type { Command } from 'commander'
import type { AgentPermissionRequest, AgentSnapshotPayload } from '@paseo/server'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'

/** Permission list item for display */
export interface PermissionListItem {
  id: string
  agentId: string
  agentShortId: string
  name: string
  description: string
}

/** Schema for permit ls output */
export const permitLsSchema: OutputSchema<PermissionListItem> = {
  idField: 'id',
  columns: [
    { header: 'AGENT', field: 'agentShortId', width: 12 },
    { header: 'REQ_ID', field: 'id', width: 12 },
    { header: 'TOOL', field: 'name', width: 20 },
    { header: 'DESCRIPTION', field: 'description', width: 50 },
  ],
}

/** Transform agent snapshot + permission to list item */
function toListItem(agent: AgentSnapshotPayload, permission: AgentPermissionRequest): PermissionListItem {
  return {
    id: permission.id.slice(0, 8),
    agentId: agent.id,
    agentShortId: agent.id.slice(0, 7),
    name: permission.name,
    description: permission.description ?? '-',
  }
}

export type PermitLsResult = ListResult<PermissionListItem>

export interface PermitLsOptions extends CommandOptions {
  host?: string
}

export async function runLsCommand(options: PermitLsOptions, _command: Command): Promise<PermitLsResult> {
  const host = getDaemonHost({ host: options.host })

  let client
  try {
    client = await connectToDaemon({ host: options.host })
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
    await client.close()

    // Collect all pending permissions from all agents
    const items: PermissionListItem[] = []
    for (const agent of agents) {
      if (agent.pendingPermissions && agent.pendingPermissions.length > 0) {
        for (const permission of agent.pendingPermissions) {
          items.push(toListItem(agent, permission))
        }
      }
    }

    return {
      type: 'list',
      data: items,
      schema: permitLsSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'LIST_PERMISSIONS_FAILED',
      message: `Failed to list permissions: ${message}`,
    }
    throw error
  }
}
