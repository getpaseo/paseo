import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost, resolveAgentId } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'
import type {
  DaemonClientV2,
  AgentStreamMessage,
  AgentStreamSnapshotMessage,
  AgentTimelineItem,
} from '@paseo/server'

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
  filter?: string
  since?: string
}

export type AgentLogsResult = ListResult<LogEntry>

/** Format a timeline item into a log entry */
function formatTimelineItem(item: AgentTimelineItem): LogEntry {
  const now = new Date().toISOString().slice(11, 19) // HH:MM:SS

  switch (item.type) {
    case 'user_message':
      return {
        timestamp: now,
        type: 'user',
        summary: truncate(item.text, 60),
      }
    case 'assistant_message':
      return {
        timestamp: now,
        type: 'assistant',
        summary: truncate(item.text, 60),
      }
    case 'reasoning':
      return {
        timestamp: now,
        type: 'reasoning',
        summary: truncate(item.text, 60),
      }
    case 'tool_call': {
      const toolName = item.name
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
      const completed = item.items.filter((i) => i.completed).length
      return {
        timestamp: now,
        type: 'todo',
        summary: `${completed}/${item.items.length} completed`,
      }
    }
    case 'error':
      return {
        timestamp: now,
        type: 'error',
        summary: truncate(item.message, 60),
      }
  }
}

function truncate(str: string, maxLen: number): string {
  const cleaned = str.replace(/\n/g, ' ').trim()
  if (cleaned.length <= maxLen) return cleaned
  return cleaned.slice(0, maxLen - 3) + '...'
}

/**
 * Check if a timeline item matches the filter type
 */
function matchesFilter(item: AgentTimelineItem, filter?: string): boolean {
  if (!filter) return true

  const filterLower = filter.toLowerCase()
  const type = item.type.toLowerCase()

  switch (filterLower) {
    case 'tools':
      return type === 'tool_call'
    case 'text':
      return type === 'user_message' || type === 'assistant_message' || type === 'reasoning'
    case 'errors':
      return type === 'error'
    case 'permissions':
      // Permissions might be in tool_call status or a separate event type
      return type.includes('permission')
    default:
      // If filter doesn't match predefined types, match against the actual type
      return type.includes(filterLower)
  }
}

/**
 * Parse a timestamp string and return a Date object
 * Supports ISO format and relative times like "5m", "1h", "2d"
 */
function parseTimestamp(timeStr: string): Date | null {
  // Try ISO format first
  const isoDate = new Date(timeStr)
  if (!isNaN(isoDate.getTime())) {
    return isoDate
  }

  // Try relative time format (e.g., "5m", "1h", "2d")
  const match = timeStr.match(/^(\d+)([smhd])$/)
  if (match) {
    const value = parseInt(match[1], 10)
    const unit = match[2]
    const now = new Date()

    switch (unit) {
      case 's':
        now.setSeconds(now.getSeconds() - value)
        return now
      case 'm':
        now.setMinutes(now.getMinutes() - value)
        return now
      case 'h':
        now.setHours(now.getHours() - value)
        return now
      case 'd':
        now.setDate(now.getDate() - value)
        return now
    }
  }

  return null
}

/**
 * Extract timeline items from an agent_stream_snapshot message
 */
function extractTimelineFromSnapshot(message: AgentStreamSnapshotMessage): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = []
  for (const e of message.payload.events) {
    if (e.event.type === 'timeline') {
      items.push(e.event.item)
    }
  }
  return items
}

/**
 * Extract a timeline item from an agent_stream message
 */
function extractTimelineFromStream(message: AgentStreamMessage): AgentTimelineItem | null {
  if (message.payload.event.type === 'timeline') {
    return message.payload.event.item
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
        details: 'Use `paseo ls` to list available agents',
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
    const snapshotPromise = new Promise<AgentTimelineItem[]>((resolve) => {
      const timeout = setTimeout(() => resolve([]), 10000)

      const unsubscribe = client.on('agent_stream_snapshot', (msg: unknown) => {
        const message = msg as AgentStreamSnapshotMessage
        if (message.type !== 'agent_stream_snapshot') return
        if (message.payload.agentId !== resolvedId) return

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
        const streamMsg = msg as AgentStreamMessage
        if (streamMsg.payload.agentId === resolvedId) {
          const item = extractTimelineFromStream(streamMsg)
          if (item) {
            timelineItems.push(item)
          }
        }
      }
    }

    // Parse since timestamp if provided
    const sinceDate = options.since ? parseTimestamp(options.since) : null
    if (options.since && !sinceDate) {
      const error: CommandError = {
        code: 'INVALID_TIMESTAMP',
        message: `Invalid timestamp format: ${options.since}`,
        details: 'Use ISO format (e.g., 2024-01-15T10:30:00) or relative time (e.g., 5m, 1h, 2d)',
      }
      throw error
    }

    // Convert to log entries with filtering
    for (const item of timelineItems) {
      // Apply filter
      if (!matchesFilter(item, options.filter)) {
        continue
      }

      const entry = formatTimelineItem(item)

      // Apply since filter (note: we're using current time for all entries, this is a limitation)
      // In a real implementation, timeline items should have their own timestamps
      if (sinceDate) {
        // Since we don't have actual timestamps on timeline items, we can't filter by time
        // This would need to be implemented with proper timestamp support in the timeline items
      }

      logEntries.push(entry)
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
  const snapshotPromise = new Promise<AgentTimelineItem[]>((resolve) => {
    const timeout = setTimeout(() => resolve([]), 10000)

    const unsubscribe = client.on('agent_stream_snapshot', (msg: unknown) => {
      const message = msg as AgentStreamSnapshotMessage
      if (message.type !== 'agent_stream_snapshot') return
      if (message.payload.agentId !== agentId) return

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

  // Apply filter to existing items
  let itemsToShow = existingItems.filter((item) => matchesFilter(item, options.filter))

  // Apply tail to existing items
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
    if (message.payload.agentId !== agentId) return

    if (message.payload.event.type === 'timeline') {
      const item = message.payload.event.item
      // Apply filter
      if (!matchesFilter(item, options.filter)) {
        return
      }
      const entry = formatTimelineItem(item)
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
