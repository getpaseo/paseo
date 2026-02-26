import type { Command } from 'commander'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
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
  return basename(path)
}

export function resolveJunctionHomePath(): string {
  return process.env.JUNCTION_HOME ?? join(homedir(), '.junction')
}

export function resolveJunctionWorktreesDir(): string {
  return join(resolveJunctionHomePath(), 'worktrees')
}

function isAgentInManagedWorktree(agentCwd: string): boolean {
  const worktreesDir = resolveJunctionWorktreesDir()
  return agentCwd === worktreesDir || agentCwd.startsWith(worktreesDir + sep)
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
      details: 'Start the daemon with: junction daemon start',
    }
    throw error
  }

  try {
    const agentsPayload = await client.fetchAgents({ filter: { includeArchived: true } })
    const agents = agentsPayload.entries.map((entry) => entry.agent)

    // Get worktree list from daemon
    const response = await client.getJunctionWorktreeList({})

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
      if (isAgentInManagedWorktree(agent.cwd)) {
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
