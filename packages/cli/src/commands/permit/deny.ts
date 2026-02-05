import type { Command } from 'commander'
import type { AgentPermissionRequest } from '@getpaseo/server'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, ListResult, CommandError } from '../../output/index.js'
import { permitResponseSchema, type PermissionResponseItem } from './allow.js'

export type PermitDenyResult = ListResult<PermissionResponseItem>

export interface PermitDenyOptions extends CommandOptions {
  all?: boolean
  message?: string
  interrupt?: boolean
  host?: string
}

export async function runDenyCommand(
  agentIdOrPrefix: string,
  reqId: string | undefined,
  options: PermitDenyOptions,
  _command: Command
): Promise<PermitDenyResult> {
  const host = getDaemonHost({ host: options.host })

  // Validate arguments
  if (!options.all && !reqId) {
    const error: CommandError = {
      code: 'MISSING_ARGUMENT',
      message: 'Request ID is required unless --all is specified',
      details: 'Usage: paseo permit deny <agent> <req_id> or paseo permit deny <agent> --all',
    }
    throw error
  }

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
    const agent = await client.fetchAgent(agentIdOrPrefix)
    if (!agent) {
      await client.close()
      const error: CommandError = {
        code: 'AGENT_NOT_FOUND',
        message: `Agent not found: ${agentIdOrPrefix}`,
        details: 'Use "paseo ls" to list available agents',
      }
      throw error
    }
    const resolvedAgentId = agent.id

    // Get pending permissions for this agent
    const pendingPermissions = agent.pendingPermissions || []
    if (pendingPermissions.length === 0) {
      await client.close()
      const error: CommandError = {
        code: 'NO_PENDING_PERMISSIONS',
        message: `No pending permissions for agent ${agent.id.slice(0, 7)}`,
      }
      throw error
    }

    // Determine which permissions to deny
    let permissionsToDeny: AgentPermissionRequest[]
    if (options.all) {
      permissionsToDeny = pendingPermissions
    } else {
      // Find permission by ID prefix
      const permission = pendingPermissions.find(
        (p) => p.id === reqId || p.id.startsWith(reqId!)
      )
      if (!permission) {
        await client.close()
        const error: CommandError = {
          code: 'PERMISSION_NOT_FOUND',
          message: `Permission request not found: ${reqId}`,
          details: `Available requests: ${pendingPermissions.map((p) => p.id.slice(0, 8)).join(', ')}`,
        }
        throw error
      }
      permissionsToDeny = [permission]
    }

    // Deny permissions
    const results: PermissionResponseItem[] = []
    for (const permission of permissionsToDeny) {
      await client.respondToPermission(resolvedAgentId, permission.id, {
        behavior: 'deny',
        ...(options.message ? { message: options.message } : {}),
        ...(options.interrupt ? { interrupt: true } : {}),
      })
      results.push({
        requestId: permission.id.slice(0, 8),
        agentId: resolvedAgentId,
        agentShortId: resolvedAgentId.slice(0, 7),
        name: permission.name,
        result: 'denied',
      })
    }

    await client.close()

    return {
      type: 'list',
      data: results,
      schema: permitResponseSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})
    // Re-throw CommandErrors
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'DENY_PERMISSION_FAILED',
      message: `Failed to deny permission: ${message}`,
    }
    throw error
  }
}
