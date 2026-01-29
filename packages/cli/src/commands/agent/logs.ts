import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost, resolveAgentId } from '../../utils/client.js'
import type { CommandOptions } from '../../output/index.js'
import type {
  DaemonClientV2,
  AgentStreamMessage,
  AgentStreamSnapshotMessage,
  AgentTimelineItem,
} from '@paseo/server'
import { curateAgentActivity } from '@paseo/server'

export interface AgentLogsOptions extends CommandOptions {
  follow?: boolean
  tail?: string
  filter?: string
  since?: string
}

// Logs command returns void - it outputs directly to console
export type AgentLogsResult = void


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
    console.error('Error: Agent ID required')
    console.error('Usage: paseo agent logs <id>')
    process.exit(1)
  }

  let client: DaemonClientV2
  try {
    client = await connectToDaemon({ host: options.host as string | undefined })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: Cannot connect to daemon at ${host}: ${message}`)
    console.error('Start the daemon with: paseo daemon start')
    process.exit(1)
  }

  try {
    // Request session state to get agent information
    client.requestSessionState()

    // Wait for session state to be populated
    await new Promise((resolve) => setTimeout(resolve, 500))

    const agents = client.listAgents()
    const resolvedId = resolveAgentId(id, agents)

    if (!resolvedId) {
      console.error(`Error: No agent found matching: ${id}`)
      console.error('Use `paseo ls` to list available agents')
      await client.close()
      process.exit(1)
    }

    // For follow mode, we stream events continuously
    if (options.follow) {
      await runFollowMode(client, resolvedId, options)
      return
    }

    // For non-follow mode, initialize the agent to get timeline snapshot
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
    let timelineItems = await snapshotPromise

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

    // Apply filter
    if (options.filter) {
      timelineItems = timelineItems.filter((item) => matchesFilter(item, options.filter))
    }

    // Apply tail limit
    if (options.tail) {
      const tailCount = parseInt(options.tail, 10)
      if (!isNaN(tailCount) && tailCount > 0) {
        timelineItems = timelineItems.slice(-tailCount)
      }
    }

    await client.close()

    // Use curateAgentActivity to format the transcript
    const transcript = curateAgentActivity(timelineItems)
    console.log(transcript)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: Failed to get logs: ${message}`)
    await client.close().catch(() => {})
    process.exit(1)
  }
}

/**
 * Follow mode: stream logs in real-time until interrupted
 */
async function runFollowMode(
  client: DaemonClientV2,
  agentId: string,
  options: AgentLogsOptions
): Promise<void> {
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
  let existingItems = await snapshotPromise

  // Apply filter to existing items
  if (options.filter) {
    existingItems = existingItems.filter((item) => matchesFilter(item, options.filter))
  }

  // Apply tail to existing items
  if (options.tail) {
    const tailCount = parseInt(options.tail, 10)
    if (!isNaN(tailCount) && tailCount > 0) {
      existingItems = existingItems.slice(-tailCount)
    }
  }

  // Print existing transcript
  const existingTranscript = curateAgentActivity(existingItems)
  if (existingTranscript !== 'No activity to display.') {
    console.log(existingTranscript)
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
      if (options.filter && !matchesFilter(item, options.filter)) {
        return
      }
      // Print each timeline item as it arrives using the curator format
      const transcript = curateAgentActivity([item])
      if (transcript !== 'No activity to display.') {
        console.log(transcript)
      }
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
}
