import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'

/** Worktree list item for display */
export interface WorktreeListItem {
  name: string
  branch: string
  cwd: string
  agent: string
}

/** Shorten home directory in path */
function shortenPath(path: string): string {
  const home = process.env.HOME
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length)
  }
  return path
}

/** Extract worktree name from path */
function extractWorktreeName(path: string): string {
  // ~/.paseo/worktrees/<repo>/<name> -> name
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/** Schema for worktree ls output */
export const worktreeLsSchema: OutputSchema<WorktreeListItem> = {
  idField: 'name',
  columns: [
    { header: 'NAME', field: 'name', width: 20 },
    { header: 'BRANCH', field: 'branch', width: 25 },
    { header: 'CWD', field: 'cwd', width: 45 },
    { header: 'AGENT', field: 'agent', width: 10 },
  ],
}

export type WorktreeLsResult = ListResult<WorktreeListItem>

export interface WorktreeLsOptions extends CommandOptions {
  host?: string
}

export async function runLsCommand(
  options: WorktreeLsOptions,
  _command: Command
): Promise<WorktreeLsResult> {
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

    // Get worktree list from daemon
    const response = await client.getPaseoWorktreeList({})

    await client.close()

    if (response.error) {
      const error: CommandError = {
        code: 'WORKTREE_LIST_FAILED',
        message: `Failed to list worktrees: ${response.error.message}`,
      }
      throw error
    }

    // Build a map of worktree paths to agent IDs
    const worktreeAgentMap = new Map<string, string>()
    for (const agent of agents) {
      // Check if agent cwd is under ~/.paseo/worktrees/
      const paseoHome = process.env.PASEO_HOME ?? (process.env.HOME + '/.paseo')
      const worktreesDir = paseoHome + '/worktrees/'
      if (agent.cwd.startsWith(worktreesDir)) {
        worktreeAgentMap.set(agent.cwd, agent.id.slice(0, 7))
      }
    }

    const items: WorktreeListItem[] = response.worktrees.map((wt) => ({
      name: extractWorktreeName(wt.worktreePath),
      branch: wt.branchName ?? '-',
      cwd: shortenPath(wt.worktreePath),
      agent: worktreeAgentMap.get(wt.worktreePath) ?? '-',
    }))

    return {
      type: 'list',
      data: items,
      schema: worktreeLsSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})

    // Re-throw CommandError as-is
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }

    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'WORKTREE_LIST_FAILED',
      message: `Failed to list worktrees: ${message}`,
    }
    throw error
  }
}
