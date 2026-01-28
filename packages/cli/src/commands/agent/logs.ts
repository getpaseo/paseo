import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost, resolveAgentId } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'
import type { DaemonClientV2 } from '@paseo/server'

/** Message type for agent_stream_snapshot */
interface AgentStreamSnapshotMessage {
  type: 'agent_stream_snapshot'
  payload: {
    agentId: string
    events: Array<{ event: { type: string; item?: unknown }; timestamp: string }>
  }
}

/** Message type for agent_stream */
interface AgentStreamMessage {
  type: 'agent_stream'
  payload: {
    agentId: string
    event: { type: string; item?: unknown }
    timestamp: string
  }
}

/** Timeline item for display */
export interface LogEntry {
  timestamp: string
  type: string
  summary: string
}

/** Schema for logs output */
export const logsSchema: OutputSchema<LogEntry> = {
  idField: 'timestamp',
  columns: [
    { header: 'TIME', field: 'timestamp', width: 12 },
    { header: 'TYPE', field: 'type', width: 15 },
    { header: 'SUMMARY', field: 'summary', width: 60 },
  ],
}

export interface AgentLogsOptions extends CommandOptions {
  follow?: boolean
  tail?: string
}

export type AgentLogsResult = ListResult<LogEntry>

/** Format a timeline item into a log entry */
function formatTimelineItem(item: {
  type: string
  text?: string
  name?: string
  input?: unknown
  status?: string
  items?: { text: string; completed: boolean }[]
  message?: string
}): LogEntry {
  const now = new Date().toISOString().slice(11, 19) // HH:MM:SS

  switch (item.type) {
    case 'user_message':
      return {
        timestamp: now,
        type: 'user',
        summary: truncate(item.text ?? '', 60),
      }
    case 'assistant_message':
      return {
        timestamp: now,
        type: 'assistant',
        summary: truncate(item.text ?? '', 60),
      }
    case 'reasoning':
      return {
        timestamp: now,
        type: 'reasoning',
        summary: truncate(item.text ?? '', 60),
      }
    case 'tool_call': {
      const toolName = item.name ?? 'unknown'
      const status = item.status ?? ''
      let inputSummary = ''
      if (item.input && typeof item.input === 'object') {
        const inp = item.input as Record<string, unknown>
        // Common input fields for summarization
        if (inp.command) {
          inputSummary = truncate(String(inp.command), 40)
        } else if (inp.file_path) {
          inputSummary = truncate(String(inp.file_path), 40)
        } else if (inp.pattern) {
          inputSummary = truncate(String(inp.pattern), 40)
        }
      }
      return {
        timestamp: now,
        type: `tool:${toolName}`,
        summary: inputSummary ? `${status} ${inputSummary}`.trim() : status,
      }
    }
    case 'todo': {
      const items = item.items ?? []
      const completed = items.filter((i) => i.completed).length
      return {
        timestamp: now,
        type: 'todo',
        summary: `${completed}/${items.length} completed`,
      }
    }
    case 'error':
      return {
        timestamp: now,
        type: 'error',
        summary: truncate(item.message ?? '', 60),
      }
    default:
      return {
        timestamp: now,
        type: item.type,
        summary: '',
      }
  }
}

function truncate(str: string, maxLen: number): string {
  const cleaned = str.replace(/\n/g, ' ').trim()
  if (cleaned.length <= maxLen) return cleaned
  return cleaned.slice(0, maxLen - 3) + '...'
}

/**
 * Extract timeline items from an agent_stream_snapshot message
 */
function extractTimelineFromSnapshot(
  message: { type: string; payload: unknown }
): Array<{ type: string; [key: string]: unknown }> {
  if (message.type !== 'agent_stream_snapshot') return []

  const payload = message.payload as {
    agentId: string
    events: Array<{ event: { type: string; item?: unknown }; timestamp: string }>
  }

  const items: Array<{ type: string; [key: string]: unknown }> = []
  for (const e of payload.events) {
    if (e.event.type === 'timeline' && e.event.item) {
      items.push(e.event.item as { type: string; [key: string]: unknown })
    }
  }
  return items
}

/**
 * Extract a timeline item from an agent_stream message
 */
function extractTimelineFromStream(
  message: { type: string; payload: unknown }
): { type: string; [key: string]: unknown } | null {
  if (message.type !== 'agent_stream') return null

  const payload = message.payload as {
    agentId: string
    event: { type: string; item?: unknown }
    timestamp: string
  }

  if (payload.event.type === 'timeline' && payload.event.item) {
    return payload.event.item as { type: string; [key: string]: unknown }
  }
  return null
}

export async function runLogsCommand(
  id: string,
  options: AgentLogsOptions,
  _command: Command
): Promise<AgentLogsResult> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  if (!id) {
    const error: CommandError = {
      code: 'MISSING_ARGUMENT',
      message: 'Agent ID required',
      details: 'Usage: paseo agent logs <id>',
    }
    throw error
  }

  let client: DaemonClientV2
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

    // Wait for session state to be populated
    await new Promise((resolve) => setTimeout(resolve, 500))

    const agents = client.listAgents()
    const resolvedId = resolveAgentId(id, agents)

    if (!resolvedId) {
      const error: CommandError = {
        code: 'AGENT_NOT_FOUND',
        message: `No agent found matching: ${id}`,
        details: 'Use `paseo agent ps` to list available agents',
      }
      throw error
    }

    // For follow mode, we stream events continuously
    if (options.follow) {
      return await runFollowMode(client, resolvedId, options)
    }

    // For non-follow mode, initialize the agent to get timeline snapshot
    const logEntries: LogEntry[] = []

    // Set up handler for timeline events before initializing
    const snapshotPromise = new Promise<Array<{ type: string; [key: string]: unknown }>>((resolve) => {
      const timeout = setTimeout(() => resolve([]), 10000)

      const unsubscribe = client.on('agent_stream_snapshot', (msg: unknown) => {
        const message = msg as AgentStreamSnapshotMessage
        if (message.type !== 'agent_stream_snapshot') return
        const payload = message.payload
        if (payload.agentId !== resolvedId) return

        clearTimeout(timeout)
        unsubscribe()
        resolve(extractTimelineFromSnapshot(message))
      })
    })

    // Initialize agent to trigger timeline snapshot
    try {
      await client.initializeAgent(resolvedId)
    } catch {
      // Agent might already be initialized, continue to collect from queue
    }

    // Get timeline from snapshot
    const timelineItems = await snapshotPromise

    // Also check message queue for any stream events
    const queue = client.getMessageQueue()
    for (const msg of queue) {
      if (msg.type === 'agent_stream') {
        const payload = msg.payload as { agentId: string }
        if (payload.agentId === resolvedId) {
          const item = extractTimelineFromStream(msg)
          if (item) {
            timelineItems.push(item)
          }
        }
      }
    }

    // Convert to log entries
    for (const item of timelineItems) {
      logEntries.push(formatTimelineItem(item))
    }

    await client.close()

    // Apply tail limit
    let entries = logEntries
    if (options.tail) {
      const tailCount = parseInt(options.tail, 10)
      if (!isNaN(tailCount) && tailCount > 0) {
        entries = entries.slice(-tailCount)
      }
    }

    return {
      type: 'list',
      data: entries,
      schema: logsSchema,
    }
  } catch (err) {
    await client.close().catch(() => {})
    // Re-throw if already a CommandError
    if (err && typeof err === 'object' && 'code' in err) {
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    const error: CommandError = {
      code: 'LOGS_FAILED',
      message: `Failed to get logs: ${message}`,
    }
    throw error
  }
}

/**
 * Follow mode: stream logs in real-time until interrupted
 */
async function runFollowMode(
  client: DaemonClientV2,
  agentId: string,
  options: AgentLogsOptions
): Promise<AgentLogsResult> {
  const logEntries: LogEntry[] = []

  // First, get existing timeline
  const snapshotPromise = new Promise<Array<{ type: string; [key: string]: unknown }>>((resolve) => {
    const timeout = setTimeout(() => resolve([]), 10000)

    const unsubscribe = client.on('agent_stream_snapshot', (msg: unknown) => {
      const message = msg as AgentStreamSnapshotMessage
      if (message.type !== 'agent_stream_snapshot') return
      const payload = message.payload
      if (payload.agentId !== agentId) return

      clearTimeout(timeout)
      unsubscribe()
      resolve(extractTimelineFromSnapshot(message))
    })
  })

  // Initialize agent to trigger timeline snapshot
  try {
    await client.initializeAgent(agentId)
  } catch {
    // Agent might already be initialized
  }

  // Get existing timeline
  const existingItems = await snapshotPromise

  // Apply tail to existing items
  let itemsToShow = existingItems
  if (options.tail) {
    const tailCount = parseInt(options.tail, 10)
    if (!isNaN(tailCount) && tailCount > 0) {
      itemsToShow = itemsToShow.slice(-tailCount)
    }
  }

  // Print existing entries
  for (const item of itemsToShow) {
    const entry = formatTimelineItem(item)
    logEntries.push(entry)
    printLogEntry(entry)
  }

  // Subscribe to new events
  console.log('\n--- Following logs (Ctrl+C to stop) ---\n')

  const unsubscribe = client.on('agent_stream', (msg: unknown) => {
    const message = msg as AgentStreamMessage
    if (message.type !== 'agent_stream') return
    const payload = message.payload
    if (payload.agentId !== agentId) return

    if (payload.event.type === 'timeline' && payload.event.item) {
      const entry = formatTimelineItem(payload.event.item as { type: string; [key: string]: unknown })
      logEntries.push(entry)
      printLogEntry(entry)
    }
  })

  // Wait for interrupt
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      unsubscribe()
      resolve()
    }

    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
  })

  await client.close()

  return {
    type: 'list',
    data: logEntries,
    schema: logsSchema,
  }
}

function printLogEntry(entry: LogEntry): void {
  // Simple format for streaming output
  const typeWidth = 15
  const paddedType = entry.type.padEnd(typeWidth)
  console.log(`${entry.timestamp} ${paddedType} ${entry.summary}`)
}
