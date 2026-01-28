import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'

/** Agent snapshot type returned from daemon client */
interface AgentSnapshot {
  id: string
  provider: string
  cwd: string
  createdAt: string
  status: string
  title: string | null
}

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
  mode?: string
  cwd?: string
}

function toRunResult(agent: AgentSnapshot): AgentRunResult {
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

    // Create the agent
    const agent = await client.createAgent({
      provider: (options.provider as 'claude' | 'codex' | 'opencode') ?? 'claude',
      cwd,
      title: options.name,
      modeId: options.mode,
      initialPrompt: prompt,
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
