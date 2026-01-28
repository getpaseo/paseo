import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'

/** Minimal agent snapshot type (from daemon client) */
interface AgentSnapshot {
  id: string
  provider: string
  cwd: string
  createdAt: string
  status: string
  title: string | null
  archivedAt?: string | null
}

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

/** Schema for agent ps output */
export const agentPsSchema: OutputSchema<AgentListItem> = {
  idField: 'shortId',
  columns: [
    { header: 'AGENT ID', field: 'shortId', width: 12 },
    { header: 'NAME', field: 'name', width: 20 },
    { header: 'PROVIDER', field: 'provider', width: 10 },
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
function toListItem(agent: AgentSnapshot): AgentListItem {
  return {
    id: agent.id,
    shortId: agent.id.slice(0, 7),
    name: agent.title ?? '-',
    provider: agent.provider,
    status: agent.status,
    cwd: shortenPath(agent.cwd),
    created: relativeTime(agent.createdAt),
  }
}

export type AgentPsResult = ListResult<AgentListItem>

export interface AgentPsOptions extends CommandOptions {
  all?: boolean
  status?: string
  cwd?: string
}

export async function runPsCommand(
  options: AgentPsOptions,
  _command: Command
): Promise<AgentPsResult> {
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
    // Request session state to get agent information
    client.requestSessionState()

    // Wait a moment for the session state to be populated
    await new Promise((resolve) => setTimeout(resolve, 500))

    let agents = client.listAgents()

    // Filter out archived agents unless -a flag is set
    if (!options.all) {
      agents = agents.filter((a) => !a.archivedAt)
    }

    // Filter by status if specified
    if (options.status) {
      agents = agents.filter((a) => a.status === options.status)
    }

    // Filter by cwd if specified
    if (options.cwd) {
      const filterCwd = options.cwd
      agents = agents.filter((a) => {
        // Normalize paths for comparison
        const agentCwd = a.cwd.replace(/\/$/, '')
        const targetCwd = filterCwd.replace(/\/$/, '')
        return agentCwd === targetCwd || agentCwd.startsWith(targetCwd + '/')
      })
    }

    await client.close()

    const items = agents.map(toListItem)

    return {
      type: 'list',
      data: items,
      schema: agentPsSchema,
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
