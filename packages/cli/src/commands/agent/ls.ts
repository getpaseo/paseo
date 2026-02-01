import type { Command } from 'commander'
import type { AgentSnapshotPayload } from '@paseo/server'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'

/** Agent list item for display */
export interface AgentListItem {
  id: string
  shortId: string
  name: string
  provider: string
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

/** Schema for agent ls output */
export const agentLsSchema: OutputSchema<AgentListItem> = {
  idField: 'shortId',
  columns: [
    { header: 'AGENT ID', field: 'shortId', width: 12 },
    { header: 'NAME', field: 'name', width: 20 },
    { header: 'PROVIDER', field: 'provider', width: 15 },
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
  return {
    id: agent.id,
    shortId: agent.id.slice(0, 7),
    name: agent.title ?? '-',
    provider: agent.model ? `${agent.provider}/${agent.model}` : agent.provider,
    status: agent.status,
    cwd: shortenPath(agent.cwd),
    created: relativeTime(agent.createdAt),
  }
}

export type AgentLsResult = ListResult<AgentListItem>

export interface AgentLsOptions extends CommandOptions {
  /** -a: Include all statuses (not just running/idle) */
  all?: boolean
  /** -g: Show agents globally (not just current directory) */
  global?: boolean
  /** Filter by specific status */
  status?: string
  /** Filter by specific cwd (overrides default cwd filtering) */
  cwd?: string
  /** Filter by labels (key=value format) */
  label?: string[]
  /** Filter to UI agents only (equivalent to --label ui=true) */
  ui?: boolean
}

/**
 * Agent ls command with correct semantics from design doc:
 * - `paseo agent ls`     → running/idle agents in current directory
 * - `paseo agent ls -a`  → all statuses in current directory
 * - `paseo agent ls -g`  → running/idle agents globally
 * - `paseo agent ls -ag` → everything everywhere
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
    let agents = await client.fetchAgents()

    // Status filtering:
    // By default, only show running/idle agents (not error, archived, etc.)
    // With -a flag, show all statuses
    if (!options.all) {
      agents = agents.filter((a) => {
        // Show running and idle agents, exclude archived
        return (a.status === 'running' || a.status === 'idle') && !a.archivedAt
      })
    }

    // If explicit status filter is provided, use it
    if (options.status) {
      agents = agents.filter((a) => a.status === options.status)
    }

    // Directory filtering:
    // By default, only show agents in current working directory
    // With -g flag, show agents globally (all directories)
    if (!options.global) {
      const currentCwd = options.cwd ?? process.cwd()
      agents = agents.filter((a) => {
        // Normalize paths for comparison
        const agentCwd = a.cwd.replace(/\/$/, '')
        const targetCwd = currentCwd.replace(/\/$/, '')
        // Match exact cwd or subdirectories
        return agentCwd === targetCwd || agentCwd.startsWith(targetCwd + '/')
      })
    }

    // Label filtering:
    // Parse --label flags and --ui flag
    // --ui is equivalent to --label ui=true
    // By default (no --ui flag), show background agents (those WITHOUT ui=true)
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
    // Add ui=true filter if --ui flag is set
    if (options.ui) {
      labelFilters['ui'] = 'true'
    }

    // Apply label filtering
    if (Object.keys(labelFilters).length > 0) {
      // Filter to agents that have ALL specified labels (AND semantics)
      agents = agents.filter((a) => {
        const agentLabels = a.labels
        for (const [key, value] of Object.entries(labelFilters)) {
          if (agentLabels[key] !== value) {
            return false
          }
        }
        return true
      })
    } else {
      // Default: show background agents only (those without ui=true)
      agents = agents.filter((a) => {
        return a.labels['ui'] !== 'true'
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
