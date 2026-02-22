import type { Command } from 'commander'
import {
  getStructuredAgentResponse,
  StructuredAgentResponseError,
  type AgentSnapshotPayload,
} from '@getpaseo/server'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { lookup } from 'mime-types'

/** Result type for agent run command */
export interface AgentRunResult {
  agentId: string
  status: 'created' | 'running' | 'completed' | 'timeout' | 'permission' | 'error'
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
  thinking?: string
  mode?: string
  worktree?: string
  base?: string
  image?: string[]
  cwd?: string
  label?: string[]
  ui?: boolean
  outputSchema?: string
}

function toRunResult(
  agent: AgentSnapshotPayload,
  statusOverride?: AgentRunResult['status']
): AgentRunResult {
  return {
    agentId: agent.id,
    status: statusOverride ?? (agent.status === 'running' ? 'running' : 'created'),
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title,
  }
}

function loadOutputSchema(value: string): Record<string, unknown> {
  const trimmed = value.trim()
  if (!trimmed) {
    const error: CommandError = {
      code: 'INVALID_OUTPUT_SCHEMA',
      message: '--output-schema cannot be empty',
      details: 'Provide a JSON schema file path or inline JSON object',
    }
    throw error
  }

  let source = trimmed
  if (!trimmed.startsWith('{')) {
    try {
      source = readFileSync(resolve(trimmed), 'utf8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const error: CommandError = {
        code: 'INVALID_OUTPUT_SCHEMA',
        message: `Failed to read output schema file: ${trimmed}`,
        details: message,
      }
      throw error
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'INVALID_OUTPUT_SCHEMA',
      message: 'Failed to parse output schema JSON',
      details: message,
    }
    throw error
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error: CommandError = {
      code: 'INVALID_OUTPUT_SCHEMA',
      message: 'Output schema must be a JSON object',
    }
    throw error
  }

  return parsed as Record<string, unknown>
}

class StructuredRunStatusError extends Error {
  readonly kind: 'timeout' | 'permission' | 'error' | 'empty'

  constructor(kind: 'timeout' | 'permission' | 'error' | 'empty', message: string) {
    super(message)
    this.name = 'StructuredRunStatusError'
    this.kind = kind
  }
}

type ConnectedDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>

export interface StructuredResponseTimelineClient {
  fetchAgentTimeline: ConnectedDaemonClient['fetchAgentTimeline']
}

export async function resolveStructuredResponseMessage(options: {
  client: StructuredResponseTimelineClient
  agentId: string
  lastMessage: string | null
}): Promise<string | null> {
  const direct = options.lastMessage?.trim()
  if (direct) {
    return direct
  }

  try {
    const timeline = await options.client.fetchAgentTimeline(options.agentId, {
      direction: 'tail',
      projection: 'projected',
      limit: 200,
    })
    for (let index = timeline.entries.length - 1; index >= 0; index -= 1) {
      const entry = timeline.entries[index]
      if (!entry || entry.item.type !== 'assistant_message') {
        continue
      }
      const text = entry.item.text.trim()
      if (text.length > 0) {
        return text
      }
    }
  } catch {
    // Leave empty; caller will surface a consistent structured-output failure message.
  }

  return null
}

function structuredRunSchema(output: Record<string, unknown>): OutputSchema<AgentRunResult> {
  return {
    ...agentRunSchema,
    serialize: () => output,
  }
}

export async function runRunCommand(
  prompt: string,
  options: AgentRunOptions,
  _command: Command
): Promise<SingleResult<AgentRunResult>> {
  const host = getDaemonHost({ host: options.host as string | undefined })
  const outputSchema = options.outputSchema ? loadOutputSchema(options.outputSchema) : undefined

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

  // --output-schema always runs in attached/wait mode
  if (outputSchema && options.detach) {
    const error: CommandError = {
      code: 'INVALID_OPTIONS',
      message: '--output-schema cannot be used with --detach',
      details: 'Structured output requires waiting for the agent to finish',
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
    const thinkingOptionId = options.thinking?.trim()
    if (options.thinking !== undefined && !thinkingOptionId) {
      const error: CommandError = {
        code: 'INVALID_THINKING_OPTION',
        message: '--thinking cannot be empty',
        details:
          'Provide a thinking option ID. Use "paseo provider models <provider> --thinking" to list valid IDs.',
      }
      throw error
    }

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

    // Build labels from --label and --ui flags
    // --ui is syntactic sugar for --label ui=true
    // If explicit --label ui=... is provided, it takes precedence over --ui
    const labels: Record<string, string> = {}
    if (options.label) {
      for (const labelStr of options.label) {
        const eqIndex = labelStr.indexOf('=')
        if (eqIndex === -1) {
          const error: CommandError = {
            code: 'INVALID_LABEL',
            message: `Invalid label format: ${labelStr}`,
            details: 'Labels must be in key=value format',
          }
          throw error
        }
        const key = labelStr.slice(0, eqIndex)
        const value = labelStr.slice(eqIndex + 1)
        labels[key] = value
      }
    }
    // Add ui=true if --ui flag is set and ui label not already set
    if (options.ui && !('ui' in labels)) {
      labels['ui'] = 'true'
    }

    if (outputSchema) {
      let structuredAgent: AgentSnapshotPayload | null = null

      const callStructuredTurn = async (structuredPrompt: string): Promise<string> => {
        if (!structuredAgent) {
          structuredAgent = await client.createAgent({
            provider: (options.provider as 'claude' | 'codex' | 'opencode') ?? 'claude',
            cwd,
            title: options.name,
            modeId: options.mode,
            model: options.model,
            thinkingOptionId,
            initialPrompt: structuredPrompt,
            images,
            git,
            worktreeName: options.worktree,
            labels: Object.keys(labels).length > 0 ? labels : undefined,
          })
        } else {
          await client.sendMessage(structuredAgent.id, structuredPrompt)
        }

        const state = await client.waitForFinish(structuredAgent.id, 10 * 60 * 1000)
        if (state.status === 'timeout') {
          throw new StructuredRunStatusError('timeout', 'Timed out waiting for structured output')
        }
        if (state.status === 'permission') {
          throw new StructuredRunStatusError(
            'permission',
            'Agent is waiting for permission before producing structured output'
          )
        }
        if (state.status === 'error') {
          throw new StructuredRunStatusError(
            'error',
            state.error ?? 'Agent failed before producing structured output'
          )
        }

        const lastMessage = await resolveStructuredResponseMessage({
          client,
          agentId: structuredAgent.id,
          lastMessage: state.lastMessage,
        })
        if (!lastMessage) {
          throw new StructuredRunStatusError(
            'empty',
            'Agent finished without a structured output message'
          )
        }

        return lastMessage
      }

      let output: Record<string, unknown>
      try {
        output = await getStructuredAgentResponse<Record<string, unknown>>({
          caller: callStructuredTurn,
          prompt,
          schema: outputSchema,
          schemaName: 'RunOutput',
          maxRetries: 2,
        })
      } catch (err) {
        if (err instanceof StructuredRunStatusError) {
          const error: CommandError = {
            code: 'OUTPUT_SCHEMA_FAILED',
            message: err.message,
          }
          throw error
        }
        if (err instanceof StructuredAgentResponseError) {
          const error: CommandError = {
            code: 'OUTPUT_SCHEMA_FAILED',
            message: 'Agent response did not match the required output schema',
            details:
              err.validationErrors.length > 0
                ? err.validationErrors.join('\n')
                : err.lastResponse || 'No response',
          }
          throw error
        }
        throw err
      }

      if (!structuredAgent) {
        const error: CommandError = {
          code: 'OUTPUT_SCHEMA_FAILED',
          message: 'Agent finished without a structured output message',
        }
        throw error
      }

      await client.close()

      return {
        type: 'single',
        data: toRunResult(structuredAgent, 'completed'),
        schema: structuredRunSchema(output),
      }
    }

    // Create the agent
    const agent = await client.createAgent({
      provider: (options.provider as 'claude' | 'codex' | 'opencode') ?? 'claude',
      cwd,
      title: options.name,
      modeId: options.mode,
      model: options.model,
      thinkingOptionId,
      initialPrompt: prompt,
      images,
      git,
      worktreeName: options.worktree,
      labels: Object.keys(labels).length > 0 ? labels : undefined,
    })

    // Default run behavior is foreground: wait for completion unless --detach is set.
    if (!options.detach) {
      const state = await client.waitForFinish(agent.id, 10 * 60 * 1000)
      await client.close()

      const finalAgent = state.final ?? agent
      const status: AgentRunResult['status'] =
        state.status === 'idle' ? 'completed' : state.status

      return {
        type: 'single',
        data: toRunResult(finalAgent, status),
        schema: agentRunSchema,
      }
    }

    await client.close()

    return {
      type: 'single',
      data: toRunResult(agent),
      schema: agentRunSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})

    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }

    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'AGENT_CREATE_FAILED',
      message: `Failed to create agent: ${message}`,
    }
    throw error
  }
}
