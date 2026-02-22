import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type { CommandOptions } from '../../output/index.js'
import { fetchProjectedTimelineItems } from '../../utils/timeline.js'
import type {
  DaemonClient,
  AgentStreamMessage,
  AgentTimelineItem,
} from '@getpaseo/server'
import { curateAgentActivity } from '@getpaseo/server'

export interface AgentLogsOptions extends CommandOptions {
  follow?: boolean
  tail?: string
  filter?: string
  since?: string
}

// Logs command returns void - it outputs directly to console
export type AgentLogsResult = void

export const NO_ACTIVITY_MESSAGE = 'No activity to display.'

export async function fetchAgentTimelineItems(
  client: DaemonClient,
  agentId: string
): Promise<AgentTimelineItem[]> {
  return fetchProjectedTimelineItems({ client, agentId })
}

export function formatAgentActivityTranscript(
  timelineItems: AgentTimelineItem[],
  tailCount?: number
): string {
  if (tailCount === 0) {
    return ''
  }
  return curateAgentActivity(
    timelineItems,
    tailCount !== undefined ? { maxItems: tailCount } : undefined
  )
}

function parseTailCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed < 0) {
    return undefined
  }
  return parsed
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

  let client: DaemonClient
  try {
    client = await connectToDaemon({ host: options.host as string | undefined })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: Cannot connect to daemon at ${host}: ${message}`)
    console.error('Start the daemon with: paseo daemon start')
    process.exit(1)
  }

  try {
    const fetchResult = await client.fetchAgent(id)
    if (!fetchResult) {
      console.error(`Error: No agent found matching: ${id}`)
      console.error('Use `paseo ls` to list available agents')
      await client.close()
      process.exit(1)
    }
    const resolvedId = fetchResult.agent.id

    // For follow mode, we stream events continuously
    if (options.follow) {
      if (options.tail !== undefined && parseTailCount(options.tail) === undefined) {
        console.error(`Error: Invalid --tail value: ${options.tail}`)
        console.error('Usage: --tail <n> (where n is >= 0)')
        await client.close().catch(() => {})
        process.exit(1)
      }
      await runFollowMode(client, resolvedId, options)
      return
    }

    // Fetch timeline directly via cursor RPC.
    let timelineItems = await fetchAgentTimelineItems(client, resolvedId)

    // Apply filter
    if (options.filter) {
      timelineItems = timelineItems.filter((item) => matchesFilter(item, options.filter))
    }

    const tailCount = parseTailCount(options.tail)
    if (options.tail !== undefined && tailCount === undefined) {
      console.error(`Error: Invalid --tail value: ${options.tail}`)
      console.error('Usage: --tail <n> (where n is >= 0)')
      await client.close().catch(() => {})
      process.exit(1)
    }

    await client.close()

    // Use curateAgentActivity to format the transcript
    if (tailCount === 0) {
      return
    }

    const transcript = formatAgentActivityTranscript(timelineItems, tailCount)
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
  client: DaemonClient,
  agentId: string,
  options: AgentLogsOptions
): Promise<void> {
  const DEFAULT_FOLLOW_TAIL = 10
  const tailCount = parseTailCount(options.tail) ?? DEFAULT_FOLLOW_TAIL

  // First, get existing timeline.
  let existingItems = await fetchAgentTimelineItems(client, agentId)

  // Apply filter to existing items
  if (options.filter) {
    existingItems = existingItems.filter((item) => matchesFilter(item, options.filter))
  }

  // Print existing transcript (tail-like behavior)
  if (tailCount > 0) {
    const existingTranscript = formatAgentActivityTranscript(existingItems, tailCount)
    if (existingTranscript !== NO_ACTIVITY_MESSAGE) {
      console.log(existingTranscript)
    }
  }

  // Subscribe to new events
  const tailLabel = tailCount === 0 ? 'no history' : `last ${tailCount} entr${tailCount === 1 ? 'y' : 'ies'}`
  console.log(`\n--- Following logs (${tailLabel}; Ctrl+C to stop) ---\n`)

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
      const transcript = formatAgentActivityTranscript([item])
      if (transcript !== NO_ACTIVITY_MESSAGE) {
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
