import type { Command } from 'commander'
import type { AgentSnapshotPayload } from '@paseo/server'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { lookup } from 'mime-types'

/** Result type for agent run command */
export interface AgentRunResult {
  agentId: string
  status: 'created' | 'running'
  provider: string
  cwd: string
  title: string | null
}

/** Schema for agent run output */
export const agentRunSchema: OutputSchema<AgentRunResult> = {
  idField: 'agentId',
  columns: [
    { header: 'AGENT ID', field: 'agentId', width: 12 },
    { header: 'STATUS', field: 'status', width: 10 },
    { header: 'PROVIDER', field: 'provider', width: 10 },
    { header: 'CWD', field: 'cwd', width: 30 },
    { header: 'TITLE', field: 'title', width: 20 },
  ],
}

export interface AgentRunOptions extends CommandOptions {
  detach?: boolean
  name?: string
  provider?: string
  model?: string
  mode?: string
  worktree?: string
  base?: string
  image?: string[]
  cwd?: string
}

function toRunResult(agent: AgentSnapshotPayload): AgentRunResult {
  return {
    agentId: agent.id,
    status: agent.status === 'running' ? 'running' : 'created',
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title,
  }
}

export async function runRunCommand(
  prompt: string,
  options: AgentRunOptions,
  _command: Command
): Promise<SingleResult<AgentRunResult>> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  // Validate prompt is provided
  if (!prompt || prompt.trim().length === 0) {
    const error: CommandError = {
      code: 'MISSING_PROMPT',
      message: 'A prompt is required',
      details: 'Usage: paseo agent run [options] <prompt>',
    }
    throw error
  }

  // Validate --base is only used with --worktree
  if (options.base && !options.worktree) {
    const error: CommandError = {
      code: 'INVALID_OPTIONS',
      message: '--base can only be used with --worktree',
      details: 'Usage: paseo agent run --worktree <name> --base <branch> <prompt>',
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
    // Resolve working directory
    const cwd = options.cwd ?? process.cwd()

    // Process images if provided
    let images: Array<{ data: string; mimeType: string }> | undefined
    if (options.image && options.image.length > 0) {
      images = options.image.map((imagePath) => {
        const resolvedPath = resolve(imagePath)
        try {
          const imageData = readFileSync(resolvedPath)
          const mimeType = lookup(resolvedPath) || 'application/octet-stream'

          // Verify it's an image MIME type
          if (!mimeType.startsWith('image/')) {
            throw new Error(`File is not an image: ${imagePath} (detected type: ${mimeType})`)
          }

          return {
            data: imageData.toString('base64'),
            mimeType,
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`Failed to read image ${imagePath}: ${message}`)
        }
      })
    }

    // Build git options if worktree is specified
    const git = options.worktree
      ? {
          createWorktree: true,
          worktreeSlug: options.worktree,
          baseBranch: options.base,
        }
      : undefined

    // Create the agent
    const agent = await client.createAgent({
      provider: (options.provider as 'claude' | 'codex' | 'opencode') ?? 'claude',
      cwd,
      title: options.name,
      modeId: options.mode,
      model: options.model,
      initialPrompt: prompt,
      images,
      git,
      worktreeName: options.worktree,
    })

    await client.close()

    return {
      type: 'single',
      data: toRunResult(agent),
      schema: agentRunSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'AGENT_CREATE_FAILED',
      message: `Failed to create agent: ${message}`,
    }
    throw error
  }
}
