import type { Command } from 'commander'
import { connectToDaemon, getDaemonHost } from '../../utils/client.js'
import type {
  DaemonClient,
  AgentStreamMessage,
  AgentStreamSnapshotMessage,
  AgentStreamEventPayload,
  AgentTimelineItem,
} from '@getpaseo/server'

export interface AgentAttachOptions {
  host?: string
  [key: string]: unknown
}

/**
 * Format and print a timeline item to the terminal
 */
function printTimelineItem(item: AgentTimelineItem): void {
  switch (item.type) {
    case 'assistant_message':
      // Print assistant text directly
      process.stdout.write(item.text)
      break

    case 'reasoning':
      // Print reasoning in a muted color if available
      console.log(`\n[Reasoning] ${item.text}`)
      break

    case 'tool_call': {
      const toolName = item.name
      const status = item.status ?? 'started'
      console.log(`\n[Tool: ${toolName}] ${status}`)
      break
    }

    case 'todo': {
      const completed = item.items.filter((i) => i.completed).length
      const total = item.items.length
      console.log(`\n[Todo] ${completed}/${total} completed`)
      break
    }

    case 'error':
      console.error(`\n[Error] ${item.message}`)
      break

    case 'user_message':
      console.log(`\n[User] ${item.text}`)
      break

    default:
      // Unknown item type, skip
      break
  }
}

/**
 * Format and print a stream event to the terminal
 */
function printStreamEvent(event: AgentStreamEventPayload): void {
  switch (event.type) {
    case 'timeline':
      // Print the timeline item
      printTimelineItem(event.item)
      break

    case 'permission_requested':
      console.log(`\n[Permission Required] ${event.request.name}`)
      if (event.request.description) {
        console.log(`  ${event.request.description}`)
      }
      break

    case 'permission_resolved':
      console.log(`\n[Permission ${event.resolution.behavior}]`)
      break

    case 'turn_failed':
      console.error(`\n[Turn Failed] ${event.error}`)
      break

    case 'attention_required':
      console.log(`\n[Attention Required: ${event.reason}]`)
      break

    default:
      // Other event types (thread_started, provider_event, etc.) are internal
      break
  }
}

/**
 * Attach to a running agent's output stream
 */
export async function runAttachCommand(
  id: string,
  options: AgentAttachOptions,
  _command: Command
): Promise<void> {
  const host = getDaemonHost({ host: options.host as string | undefined })

  if (!id) {
    console.error('Error: Agent ID required')
    console.error('Usage: paseo attach <id>')
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
    const agent = await client.fetchAgent(id)
    if (!agent) {
      console.error(`Error: No agent found matching: ${id}`)
      console.error('Use `paseo ls` to list available agents')
      await client.close()
      process.exit(1)
    }
    const resolvedId = agent.id

    // Print header
    console.log(`Attaching to agent ${resolvedId.substring(0, 7)}...`)
    console.log(`(Press Ctrl+C to detach)\n`)

    // Get existing output from snapshot
    const snapshotPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 5000)

      const unsubscribe = client.on('agent_stream_snapshot', (msg: unknown) => {
        const message = msg as AgentStreamSnapshotMessage
        if (message.type !== 'agent_stream_snapshot') return
        if (message.payload.agentId !== resolvedId) return

        clearTimeout(timeout)
        unsubscribe()

        // Print recent events from snapshot
        for (const e of message.payload.events) {
          printStreamEvent(e.event)
        }

        resolve()
      })
    })

    // Initialize agent to trigger snapshot
    try {
      await client.initializeAgent(resolvedId)
    } catch {
      // Agent might already be initialized, continue
    }

    // Wait for snapshot
    await snapshotPromise

    // Subscribe to new events
    const unsubscribe = client.on('agent_stream', (msg: unknown) => {
      const message = msg as AgentStreamMessage
      if (message.type !== 'agent_stream') return
      if (message.payload.agentId !== resolvedId) return

      printStreamEvent(message.payload.event)
    })

    // Handle Ctrl+C to detach gracefully
    let detached = false
    const detach = () => {
      if (detached) return
      detached = true

      console.log('\n\nDetaching from agent...')
      unsubscribe()
      client
        .close()
        .then(() => {
          process.exit(0)
        })
        .catch(() => {
          process.exit(1)
        })
    }

    process.on('SIGINT', detach)
    process.on('SIGTERM', detach)

    // Keep the process alive
    await new Promise(() => {
      // Wait indefinitely until interrupted
    })
  } catch (err) {
    await client.close().catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: Failed to attach to agent: ${message}`)
    process.exit(1)
  }
}
