import type { Command } from 'commander'
import type { AgentSnapshotPayload } from '@paseo/server'
import { connectToDaemon, getDaemonHost, resolveAgentId } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'

/** Agent inspect data for display */
interface AgentInspect {
  id: string
  name: string
  provider: string
  model: string
  status: string
  mode: string
  cwd: string
  createdAt: string
  archivedAt: string | null
  lastUsage: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    totalCostUsd: number
  } | null
  capabilities: {
    streaming: boolean
    persistence: boolean
    dynamicModes: boolean
    mcpServers: boolean
  } | null
  availableModes: Array<{
    id: string
    label: string
  }> | null
  pendingPermissions: Array<{
    id: string
    tool: string
  }>
}

/** Key-value row for table display */
interface InspectRow {
  key: string
  value: string
}

/** Schema for key-value display with custom serialization for JSON/YAML */
function createInspectSchema(agent: AgentInspect): OutputSchema<InspectRow> {
  return {
    idField: 'key',
    columns: [
      { header: 'KEY', field: 'key' },
      {
        header: 'VALUE',
        field: 'value',
        color: (_, item) => {
          if (item.key === 'Status') {
            if (item.value === 'running') return 'green'
            if (item.value === 'idle') return 'yellow'
            if (item.value === 'error') return 'red'
          }
          return undefined
        },
      },
    ],
    // For JSON/YAML, return the structured agent object
    serialize: (_item) => agent,
  }
}

/** Shorten home directory in path */
function shortenPath(path: string): string {
  const home = process.env.HOME
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length)
  }
  return path
}

/** Format cost in USD */
function formatCost(costUsd: number): string {
  if (costUsd === 0) return '$0.00'
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`
  return `$${costUsd.toFixed(2)}`
}

/** Convert agent snapshot to inspection data */
function toInspectData(snapshot: AgentSnapshotPayload): AgentInspect {
  const lastUsage = snapshot.lastUsage
    ? {
        inputTokens: snapshot.lastUsage.inputTokens ?? 0,
        outputTokens: snapshot.lastUsage.outputTokens ?? 0,
        cachedInputTokens: snapshot.lastUsage.cachedInputTokens ?? 0,
        totalCostUsd: snapshot.lastUsage.totalCostUsd ?? 0,
      }
    : null

  const capabilities = snapshot.capabilities
    ? {
        streaming: snapshot.capabilities.supportsStreaming ?? false,
        persistence: snapshot.capabilities.supportsSessionPersistence ?? false,
        dynamicModes: snapshot.capabilities.supportsDynamicModes ?? false,
        mcpServers: snapshot.capabilities.supportsMcpServers ?? false,
      }
    : null

  return {
    id: snapshot.id,
    name: snapshot.title ?? '-',
    provider: snapshot.provider,
    model: snapshot.model ?? '-',
    status: snapshot.status,
    mode: snapshot.currentModeId ?? 'default',
    cwd: snapshot.cwd,
    createdAt: snapshot.createdAt,
    archivedAt: snapshot.archivedAt ?? null,
    lastUsage,
    capabilities,
    availableModes: snapshot.availableModes
      ? snapshot.availableModes.map((m) => ({ id: m.id, label: m.label }))
      : null,
    pendingPermissions: (snapshot.pendingPermissions ?? []).map((p) => ({
      id: p.id,
      tool: p.name ?? 'unknown',
    })),
  }
}

/** Convert agent to key-value rows for table display */
function toInspectRows(agent: AgentInspect): InspectRow[] {
  const rows: InspectRow[] = [
    { key: 'Id', value: agent.id },
    { key: 'Name', value: agent.name },
    { key: 'Provider', value: agent.provider },
    { key: 'Model', value: agent.model },
    { key: 'Status', value: agent.status },
    { key: 'Mode', value: agent.mode },
    { key: 'Cwd', value: shortenPath(agent.cwd) },
    { key: 'CreatedAt', value: agent.createdAt },
  ]

  if (agent.archivedAt) {
    rows.push({ key: 'ArchivedAt', value: agent.archivedAt })
  }

  if (agent.lastUsage) {
    rows.push({
      key: 'LastUsage',
      value: `${agent.lastUsage.inputTokens} in, ${agent.lastUsage.outputTokens} out, ${formatCost(agent.lastUsage.totalCostUsd)}`,
    })
  }

  if (agent.capabilities) {
    const caps = agent.capabilities
    const capsList = [
      caps.streaming ? 'Streaming' : null,
      caps.persistence ? 'Persistence' : null,
      caps.dynamicModes ? 'DynamicModes' : null,
      caps.mcpServers ? 'McpServers' : null,
    ].filter(Boolean)
    rows.push({ key: 'Capabilities', value: capsList.join(', ') || 'none' })
  }

  if (agent.availableModes && agent.availableModes.length > 0) {
    rows.push({
      key: 'AvailableModes',
      value: agent.availableModes.map((m) => m.id).join(', '),
    })
  }

  if (agent.pendingPermissions.length > 0) {
    rows.push({
      key: 'PendingPermissions',
      value: agent.pendingPermissions.length.toString(),
    })
  } else {
    rows.push({ key: 'PendingPermissions', value: '[]' })
  }

  return rows
}

export type AgentInspectResult = ListResult<InspectRow>

export interface AgentInspectOptions extends CommandOptions {
  host?: string
}

export async function runInspectCommand(
  agentIdArg: string,
  options: AgentInspectOptions,
  _command: Command
): Promise<AgentInspectResult> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: 'MISSING_AGENT_ID',
      message: 'Agent ID is required',
      details: 'Usage: paseo agent inspect <id>',
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
    const agentId = resolveAgentId(agentIdArg, agents)
    if (!agentId) {
      const error: CommandError = {
        code: 'AGENT_NOT_FOUND',
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls" to list available agents',
      }
      throw error
    }

    // Get the full agent snapshot
    const snapshot = agents.find((a) => a.id === agentId)
    if (!snapshot) {
      const error: CommandError = {
        code: 'AGENT_NOT_FOUND',
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls" to list available agents',
      }
      throw error
    }

    await client.close()

    const inspectData = toInspectData(snapshot)

    return {
      type: 'list',
      data: toInspectRows(inspectData),
      schema: createInspectSchema(inspectData),
    }
  } catch (err) {
    await client.close().catch(() => {})

    // Re-throw CommandError as-is
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }

    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'INSPECT_FAILED',
      message: `Failed to inspect agent: ${message}`,
    }
    throw error
  }
}
