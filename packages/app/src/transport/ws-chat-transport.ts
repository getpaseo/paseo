/**
 * WebSocket Chat Transport
 *
 * Bridges Junction's DaemonClient to the chat UI by converting daemon
 * agent_stream events into a readable stream of ChatStreamParts.
 */

import type { DaemonClient, DaemonEvent } from "@server/client/daemon-client"
import { mapDaemonEventToStreamParts, type ChatStreamPart } from "./event-mapper"

export interface ChatTransportOptions {
  /** The DaemonClient instance to use */
  client: DaemonClient
  /** The agent ID to communicate with */
  agentId: string
}

export interface SendMessageOptions {
  /** Images to attach */
  images?: Array<{ data: string; mimeType: string }>
}

/**
 * Sends a message to an agent and returns a readable stream of ChatStreamParts.
 *
 * Usage:
 * ```ts
 * const stream = await sendMessageToAgent({
 *   client: daemonClient,
 *   agentId: "abc123",
 *   text: "Hello, what's 2+2?",
 * })
 *
 * for await (const part of stream) {
 *   if (part.type === "text-delta") {
 *     appendText(part.textDelta)
 *   }
 * }
 * ```
 */
export function sendMessageToAgent(options: {
  client: DaemonClient
  agentId: string
  text: string
  messageOptions?: SendMessageOptions
}): {
  stream: ReadableStream<ChatStreamPart>
  cancel: () => void
} {
  const { client, agentId, text, messageOptions } = options
  let unsubscribe: (() => void) | null = null
  let cancelled = false

  const stream = new ReadableStream<ChatStreamPart>({
    start(controller) {
      // Subscribe to agent events
      unsubscribe = client.subscribe((event: DaemonEvent) => {
        if (cancelled) return

        // Only handle events for our agent
        if (event.type === "agent_stream" && event.agentId === agentId) {
          const parts = mapDaemonEventToStreamParts(event)
          for (const part of parts) {
            controller.enqueue(part)
            // Close stream on finish or error
            if (part.type === "finish" || part.type === "error") {
              try {
                controller.close()
              } catch {
                // Already closed
              }
              unsubscribe?.()
              unsubscribe = null
              return
            }
          }
        }

        // Handle permission events
        if (
          event.type === "agent_permission_request" &&
          event.agentId === agentId
        ) {
          controller.enqueue({
            type: "permission-request",
            id: event.request.id,
            name: event.request.name,
            kind: event.request.kind,
            title: event.request.title,
            description: event.request.description,
            input: event.request.input,
          })
        }

        if (
          event.type === "agent_permission_resolved" &&
          event.agentId === agentId
        ) {
          controller.enqueue({
            type: "permission-resolved",
            requestId: event.requestId,
          })
        }
      })

      // Send the message
      client.sendAgentMessage(agentId, text, messageOptions).catch((err) => {
        if (!cancelled) {
          controller.enqueue({
            type: "error",
            error: err instanceof Error ? err.message : "Failed to send message",
          })
          try {
            controller.close()
          } catch {
            // Already closed
          }
        }
      })
    },

    cancel() {
      cancelled = true
      unsubscribe?.()
      unsubscribe = null
    },
  })

  return {
    stream,
    cancel: () => {
      cancelled = true
      unsubscribe?.()
      unsubscribe = null
      client.cancelAgent(agentId).catch(() => {})
    },
  }
}

/**
 * Creates an agent and returns its ID along with a stream of initial events.
 */
export async function createAgentAndStream(options: {
  client: DaemonClient
  provider?: "claude" | "codex" | "opencode"
  cwd?: string
  initialPrompt?: string
}): Promise<{
  agentId: string
  stream: ReadableStream<ChatStreamPart>
  cancel: () => void
}> {
  const { client, provider, cwd, initialPrompt } = options

  const agent = await client.createAgent({
    provider: provider ?? "claude",
    cwd,
    initialPrompt,
  })

  if (!initialPrompt) {
    // No initial prompt, no stream needed
    return {
      agentId: agent.id,
      stream: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
      cancel: () => {},
    }
  }

  // Subscribe to the stream for the initial prompt response
  let unsubscribe: (() => void) | null = null
  let cancelled = false

  const stream = new ReadableStream<ChatStreamPart>({
    start(controller) {
      unsubscribe = client.subscribe((event: DaemonEvent) => {
        if (cancelled) return

        if (event.type === "agent_stream" && event.agentId === agent.id) {
          const parts = mapDaemonEventToStreamParts(event)
          for (const part of parts) {
            controller.enqueue(part)
            if (part.type === "finish" || part.type === "error") {
              try {
                controller.close()
              } catch {
                // Already closed
              }
              unsubscribe?.()
              unsubscribe = null
              return
            }
          }
        }
      })
    },

    cancel() {
      cancelled = true
      unsubscribe?.()
      unsubscribe = null
    },
  })

  return {
    agentId: agent.id,
    stream,
    cancel: () => {
      cancelled = true
      unsubscribe?.()
      unsubscribe = null
      client.cancelAgent(agent.id).catch(() => {})
    },
  }
}
