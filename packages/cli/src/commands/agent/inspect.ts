import type { Command } from 'commander'
import type { AgentSnapshotPayload } from '@junction/server'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'

/** Agent inspect data for display (matches CLI spec format) */
interface AgentInspect {
  Id: string
  Name: string
  Provider: string
  Model: string
  Thinking: string
  Status: string
  Mode: string
  Cwd: string
  CreatedAt: string
  UpdatedAt: string
  LastUsage: {
    InputTokens: number
    OutputTokens: number
    CachedTokens: number
    CostUsd: number
  } | null
  Capabilities: {
    Streaming: boolean
    Persistence: boolean
    DynamicModes: boolean
    McpServers: boolean
  } | null
  AvailableModes: Array<{
    id: string
    label: string
  }> | null
  PendingPermissions: Array<{
    id: string
    tool: string
  }>
  Worktree: string | null
  ParentAgentId: string | null
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

function normalizeModelId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.toLowerCase() === 'default') return null
  return normalized
}

function resolveModel(snapshot: AgentSnapshotPayload): string | null {
  return normalizeModelId(snapshot.runtimeInfo?.model) ?? normalizeModelId(snapshot.model)
}

/** Convert agent snapshot to inspection data */
function toInspectData(snapshot: AgentSnapshotPayload): AgentInspect {
  const lastUsage = snapshot.lastUsage
    ? {
        InputTokens: snapshot.lastUsage.inputTokens ?? 0,
        OutputTokens: snapshot.lastUsage.outputTokens ?? 0,
        CachedTokens: snapshot.lastUsage.cachedInputTokens ?? 0,
        CostUsd: snapshot.lastUsage.totalCostUsd ?? 0,
      }
    : null

  const capabilities = snapshot.capabilities
    ? {
        Streaming: snapshot.capabilities.supportsStreaming ?? false,
        Persistence: snapshot.capabilities.supportsSessionPersistence ?? false,
        DynamicModes: snapshot.capabilities.supportsDynamicModes ?? false,
        McpServers: snapshot.capabilities.supportsMcpServers ?? false,
      }
    : null

  // Extract worktree and parentAgentId from labels if they exist
  const worktree = snapshot.labels?.['junction.worktree'] ?? null
  const parentAgentId = snapshot.labels?.['junction.parent-agent-id'] ?? null

  return {
    Id: snapshot.id,
    Name: snapshot.title ?? '-',
    Provider: snapshot.provider,
    Model: resolveModel(snapshot) ?? '-',
    Thinking: snapshot.effectiveThinkingOptionId ?? 'auto',
    Status: snapshot.status,
    Mode: snapshot.currentModeId ?? 'default',
    Cwd: snapshot.cwd,
    CreatedAt: snapshot.createdAt,
    UpdatedAt: snapshot.updatedAt,
    LastUsage: lastUsage,
    Capabilities: capabilities,
    AvailableModes: snapshot.availableModes
      ? snapshot.availableModes.map((m) => ({ id: m.id, label: m.label }))
      : null,
    PendingPermissions: (snapshot.pendingPermissions ?? []).map((p) => ({
      id: p.id,
      tool: p.name ?? 'unknown',
    })),
    Worktree: worktree,
    ParentAgentId: parentAgentId,
  }
}

/** Convert agent to key-value rows for table display */
function toInspectRows(agent: AgentInspect): InspectRow[] {
  const rows: InspectRow[] = [
    { key: 'Id', value: agent.Id },
    { key: 'Name', value: agent.Name },
    { key: 'Provider', value: agent.Provider },
    { key: 'Model', value: agent.Model },
    { key: 'Thinking', value: agent.Thinking },
    { key: 'Status', value: agent.Status },
    { key: 'Mode', value: agent.Mode },
    { key: 'Cwd', value: shortenPath(agent.Cwd) },
    { key: 'CreatedAt', value: agent.CreatedAt },
    { key: 'UpdatedAt', value: agent.UpdatedAt },
  ]

  if (agent.LastUsage) {
    rows.push({
      key: 'LastUsage',
      value: `InputTokens: ${agent.LastUsage.InputTokens}, OutputTokens: ${agent.LastUsage.OutputTokens}, CachedTokens: ${agent.LastUsage.CachedTokens}, CostUsd: ${formatCost(agent.LastUsage.CostUsd)}`,
    })
  }

  if (agent.Capabilities) {
    rows.push({
      key: 'Capabilities',
      value: `Streaming: ${agent.Capabilities.Streaming}, Persistence: ${agent.Capabilities.Persistence}, DynamicModes: ${agent.Capabilities.DynamicModes}, McpServers: ${agent.Capabilities.McpServers}`,
    })
  }

  if (agent.AvailableModes && agent.AvailableModes.length > 0) {
    rows.push({
      key: 'AvailableModes',
      value: agent.AvailableModes.map((m) => `${m.id} (${m.label})`).join(', '),
    })
  }

  rows.push({
    key: 'PendingPermissions',
    value: agent.PendingPermissions.length > 0
      ? agent.PendingPermissions.map(p => `${p.id} (${p.tool})`).join(', ')
      : '[]'
  })

  rows.push({ key: 'Worktree', value: agent.Worktree ?? 'null' })
  rows.push({ key: 'ParentAgentId', value: agent.ParentAgentId ?? 'null' })

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
      details: 'Usage: junction agent inspect <id>',
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

    await client.close()

    const inspectData = toInspectData(fetchResult.agent)

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
