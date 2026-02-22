import type { Command } from 'commander'
import type { AgentSnapshotPayload } from '@getpaseo/server'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'

/** Agent list item for display */
export interface AgentListItem {
  id: string
  shortId: string
  name: string
  provider: string
  thinking: string
  status: string
  cwd: string
  created: string
}

/** Helper to get relative time string */
function relativeTime(date: Date | string): string {
  const now = Date.now()
  const then = new Date(date).getTime()
  const seconds = Math.floor((now - then) / 1000)

  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`
  return `${Math.floor(seconds / 86400)} days ago`
}

/** Shorten home directory in path */
function shortenPath(path: string): string {
  const home = process.env.HOME
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length)
  }
  return path
}

function normalizeModelId(modelId: string | null | undefined): string | null {
  if (typeof modelId !== 'string') return null
  const normalized = modelId.trim()
  if (!normalized || normalized.toLowerCase() === 'default') return null
  return normalized
}

/** Schema for agent ls output */
export const agentLsSchema: OutputSchema<AgentListItem> = {
  idField: 'shortId',
  columns: [
    { header: 'AGENT ID', field: 'shortId', width: 12 },
    { header: 'NAME', field: 'name', width: 20 },
    { header: 'PROVIDER', field: 'provider', width: 15 },
    { header: 'THINKING', field: 'thinking', width: 12 },
    {
      header: 'STATUS',
      field: 'status',
      width: 10,
      color: (value) => {
        if (value === 'running') return 'green'
        if (value === 'idle') return 'yellow'
        if (value === 'error') return 'red'
        return undefined
      },
    },
    { header: 'CWD', field: 'cwd', width: 30 },
    { header: 'CREATED', field: 'created', width: 15 },
  ],
}

/** Transform agent snapshot to AgentListItem */
function toListItem(agent: AgentSnapshotPayload): AgentListItem {
  const model = normalizeModelId(agent.runtimeInfo?.model) ?? normalizeModelId(agent.model)
  return {
    id: agent.id,
    shortId: agent.id.slice(0, 7),
    name: agent.title ?? '-',
    provider: model ? `${agent.provider}/${model}` : agent.provider,
    thinking: agent.effectiveThinkingOptionId ?? 'auto',
    status: agent.status,
    cwd: shortenPath(agent.cwd),
    created: relativeTime(agent.createdAt),
  }
}

export type AgentLsResult = ListResult<AgentListItem>

export interface AgentLsOptions extends CommandOptions {
  /** -a: Include archived agents */
  all?: boolean
  /** Legacy flag retained for CLI compatibility */
  global?: boolean
  /** Filter by specific status */
  status?: string
  /** Filter by specific cwd */
  cwd?: string
  /** Filter by labels (key=value format) */
  label?: string[]
  /** Filter by thinking option ID */
  thinking?: string
}

/**
 * Agent ls command semantics:
 * - `paseo agent ls`    → all non-archived agents
 * - `paseo agent ls -a` → include archived agents
 */
export async function runLsCommand(
  options: AgentLsOptions,
  _command: Command
): Promise<AgentLsResult> {
  const host = getDaemonHost({ host: options.host as string | undefined })

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
    const normalizedThinkingOptionId = options.thinking?.trim()
    if (options.thinking !== undefined && !normalizedThinkingOptionId) {
      const error: CommandError = {
        code: 'INVALID_THINKING_OPTION',
        message: '--thinking cannot be empty',
      }
      throw error
    }

    // Parse --label filters (key=value).
    const labelFilters: Record<string, string> = {}
    if (options.label) {
      for (const labelStr of options.label) {
        const eqIndex = labelStr.indexOf('=')
        if (eqIndex !== -1) {
          const key = labelStr.slice(0, eqIndex)
          const value = labelStr.slice(eqIndex + 1)
          labelFilters[key] = value
        }
      }
    }

    const daemonFilter: {
      includeArchived?: boolean
      labels?: Record<string, string>
      thinkingOptionId?: string
    } = {}
    if (options.all) {
      daemonFilter.includeArchived = true
    }
    if (Object.keys(labelFilters).length > 0) {
      daemonFilter.labels = labelFilters
    }
    if (normalizedThinkingOptionId) {
      daemonFilter.thinkingOptionId = normalizedThinkingOptionId
    }

    const fetchPayload = await client.fetchAgents({
      filter: Object.keys(daemonFilter).length > 0 ? daemonFilter : undefined,
    })
    let agents = fetchPayload.entries.map((entry) => entry.agent)

    // By default, exclude archived agents. `-a` includes them.
    if (!options.all) {
      agents = agents.filter((a) => !a.archivedAt)
    }

    // If explicit status filter is provided, apply it.
    if (options.status) {
      agents = agents.filter((a) => a.status === options.status)
    }

    // Optional cwd filter.
    if (options.cwd) {
      const targetCwd = options.cwd.replace(/\/$/, '')
      agents = agents.filter((a) => {
        const agentCwd = a.cwd.replace(/\/$/, '')
        return agentCwd === targetCwd || agentCwd.startsWith(targetCwd + '/')
      })
    }

    // Apply label filtering only when explicitly requested.
    if (Object.keys(labelFilters).length > 0) {
      agents = agents.filter((a) => {
        const agentLabels = a.labels
        for (const [key, value] of Object.entries(labelFilters)) {
          if (agentLabels[key] !== value) {
            return false
          }
        }
        return true
      })
    }

    await client.close()

    // Sort agents: running first, then idle, then others; within each group, most recent first
    const statusOrder = { running: 0, idle: 1 } as Record<string, number>
    agents.sort((a, b) => {
      // Primary sort: by status
      const aOrder = statusOrder[a.status] ?? 999
      const bOrder = statusOrder[b.status] ?? 999
      if (aOrder !== bOrder) return aOrder - bOrder

      // Secondary sort: by creation time (most recent first)
      const aTime = new Date(a.createdAt).getTime()
      const bTime = new Date(b.createdAt).getTime()
      return bTime - aTime
    })

    const items = agents.map(toListItem)

    return {
      type: 'list',
      data: items,
      schema: agentLsSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'LIST_AGENTS_FAILED',
      message: `Failed to list agents: ${message}`,
    }
    throw error
  }
}
