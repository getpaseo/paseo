import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions, SingleResult, OutputSchema, CommandError } from '../../output/index.js'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** Result type for agent send command */
export interface AgentSendResult {
  agentId: string
  status: 'sent' | 'completed' | 'timeout' | 'permission' | 'error'
  message: string
}

/** Schema for agent send output */
export const agentSendSchema: OutputSchema<AgentSendResult> = {
  idField: 'agentId',
  columns: [
    { header: 'AGENT ID', field: 'agentId', width: 12 },
    { header: 'STATUS', field: 'status', width: 12 },
    { header: 'MESSAGE', field: 'message', width: 40 },
  ],
}

export interface AgentSendOptions extends CommandOptions {
  noWait?: boolean
  image?: string[]
}

/**
 * Read image files and convert them to base64 data URIs
 */
async function readImageFiles(imagePaths: string[]): Promise<Array<{ data: string; mimeType: string }>> {
  const images: Array<{ data: string; mimeType: string }> = []

  for (const path of imagePaths) {
    try {
      const buffer = await readFile(path)
      const ext = extname(path).toLowerCase()

      // Determine media type from extension
      let mimeType = 'image/jpeg'
      switch (ext) {
        case '.png':
          mimeType = 'image/png'
          break
        case '.jpg':
        case '.jpeg':
          mimeType = 'image/jpeg'
          break
        case '.gif':
          mimeType = 'image/gif'
          break
        case '.webp':
          mimeType = 'image/webp'
          break
        default:
          // Default to jpeg for unknown types
          mimeType = 'image/jpeg'
      }

      const data = buffer.toString('base64')
      images.push({
        data,
        mimeType,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const error: CommandError = {
        code: 'IMAGE_READ_ERROR',
        message: `Failed to read image file: ${path}`,
        details: message,
      }
      throw error
    }
  }

  return images
}

export async function runSendCommand(
  agentIdArg: string,
  prompt: string,
  options: AgentSendOptions,
  _command: Command
): Promise<SingleResult<AgentSendResult>> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: 'MISSING_AGENT_ID',
      message: 'Agent ID is required',
      details: 'Usage: junction agent send [options] <id> <prompt>',
    }
    throw error
  }

  if (!prompt || prompt.trim().length === 0) {
    const error: CommandError = {
      code: 'MISSING_PROMPT',
      message: 'A prompt is required',
      details: 'Usage: junction agent send [options] <id> <prompt>',
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
    // Read image files if provided
    const images = options.image && options.image.length > 0
      ? await readImageFiles(options.image)
      : undefined

    // Send the message
    await client.sendAgentMessage(agentIdArg, prompt, { images })

    // If --no-wait, return immediately
    if (options.noWait) {
      await client.close()

      return {
        type: 'single',
        data: {
          agentId: agentIdArg,
          status: 'sent',
          message: 'Message sent, not waiting for completion',
        },
        schema: agentSendSchema,
      }
    }

    // Wait for agent to finish
    const state = await client.waitForFinish(agentIdArg, 600000) // 10 minute timeout

    await client.close()

    if (state.status === 'timeout') {
      return {
        type: 'single',
        data: {
          agentId: state.final?.id ?? agentIdArg,
          status: 'timeout',
          message: 'Timed out waiting for agent to finish',
        },
        schema: agentSendSchema,
      }
    }

    if (state.status === 'permission') {
      return {
        type: 'single',
        data: {
          agentId: state.final?.id ?? agentIdArg,
          status: 'permission',
          message: 'Agent is waiting for permission',
        },
        schema: agentSendSchema,
      }
    }

    if (state.status === 'error') {
      return {
        type: 'single',
        data: {
          agentId: state.final?.id ?? agentIdArg,
          status: 'error',
          message: state.error ?? 'Agent finished with error',
        },
        schema: agentSendSchema,
      }
    }

    return {
      type: 'single',
      data: {
        agentId: state.final?.id ?? agentIdArg,
        status: 'completed',
        message: 'Agent completed processing the message',
      },
      schema: agentSendSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})

    // Re-throw CommandError as-is
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }

    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'SEND_FAILED',
      message: `Failed to send message: ${message}`,
    }
    throw error
  }
}
