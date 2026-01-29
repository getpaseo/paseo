import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'

/** Result type for worktree archive command */
export interface WorktreeArchiveResult {
  name: string
  status: 'archived'
  removedAgents: string[]
}

/** Schema for archive command output */
export const archiveSchema: OutputSchema<WorktreeArchiveResult> = {
  idField: 'name',
  columns: [
    { header: 'NAME', field: 'name' },
    { header: 'STATUS', field: 'status' },
    {
      header: 'REMOVED AGENTS',
      field: (item) => item.removedAgents.length > 0 ? item.removedAgents.join(', ') : '-',
    },
  ],
}

export interface WorktreeArchiveOptions extends CommandOptions {
  host?: string
}

export type WorktreeArchiveCommandResult = SingleResult<WorktreeArchiveResult>

export async function runArchiveCommand(
  nameArg: string,
  options: WorktreeArchiveOptions,
  _command: Command
): Promise<WorktreeArchiveCommandResult> {
  const host = getDaemonHost({ host: options.host })

  // Validate arguments
  if (!nameArg || nameArg.trim().length === 0) {
    const error: CommandError = {
      code: 'MISSING_WORKTREE_NAME',
      message: 'Worktree name is required',
      details: 'Usage: paseo worktree archive <name>',
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
    // Get the list of worktrees first to resolve the name
    const listResponse = await client.getPaseoWorktreeList({})

    if (listResponse.error) {
      const error: CommandError = {
        code: 'WORKTREE_LIST_FAILED',
        message: `Failed to list worktrees: ${listResponse.error.message}`,
      }
      throw error
    }

    // Find the worktree by name or branch
    const worktree = listResponse.worktrees.find((wt) => {
      const name = wt.worktreePath.split('/').pop()
      return name === nameArg || wt.branchName === nameArg
    })

    if (!worktree) {
      const error: CommandError = {
        code: 'WORKTREE_NOT_FOUND',
        message: `Worktree not found: ${nameArg}`,
        details: 'Use "paseo worktree ls" to list available worktrees',
      }
      throw error
    }

    // Archive the worktree
    const response = await client.archivePaseoWorktree({
      worktreePath: worktree.worktreePath,
    })

    await client.close()

    if (response.error) {
      const error: CommandError = {
        code: 'WORKTREE_ARCHIVE_FAILED',
        message: `Failed to archive worktree: ${response.error.message}`,
      }
      throw error
    }

    const worktreeName = worktree.worktreePath.split('/').pop() ?? nameArg

    return {
      type: 'single',
      data: {
        name: worktreeName,
        status: 'archived',
        removedAgents: response.removedAgents ?? [],
      },
      schema: archiveSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})

    // Re-throw CommandError as-is
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }

    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'WORKTREE_ARCHIVE_FAILED',
      message: `Failed to archive worktree: ${message}`,
    }
    throw error
  }
}
