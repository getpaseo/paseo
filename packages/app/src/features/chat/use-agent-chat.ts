/**
 * Hook for managing agent chat state with the daemon transport layer.
 *
 * Provides message state, streaming control, and permission handling
 * for a single agent conversation. Loads existing timeline history
 * when selecting a previously created agent.
 */

import { useState, useCallback, useRef, useEffect } from "react"
import type { DaemonClient, DaemonEvent } from "@server/client/daemon-client"
import type { FetchAgentTimelinePayload } from "@server/client/daemon-client"
import {
  sendMessageToAgent,
  createAgentAndStream,
} from "@/transport/ws-chat-transport"
import {
  mapDaemonEventToStreamParts,
  type ChatStreamPart,
  type ToolCallDetail,
} from "@/transport/event-mapper"

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  toolCalls?: ToolCallInfo[]
  reasoning?: string
  usage?: { inputTokens?: number; outputTokens?: number; totalCostUsd?: number }
  createdAt: Date
}

export interface ToolCallInfo {
  toolCallId: string
  toolName: string
  status: "running" | "completed" | "failed" | "canceled"
  detail: ToolCallDetail
  error?: string | null
}

export interface PermissionRequest {
  id: string
  agentId: string
  name: string
  kind: string
  title?: string
  description?: string
  input?: Record<string, unknown>
}

export interface UseAgentChatOptions {
  client: DaemonClient
  agentId?: string
  provider?: "claude" | "codex" | "opencode"
  cwd?: string
}

export interface UseAgentChatReturn {
  messages: ChatMessage[]
  isStreaming: boolean
  isLoadingHistory: boolean
  error: string | null
  agentId: string | null
  pendingPermission: PermissionRequest | null
  send: (text: string) => Promise<void>
  stop: () => void
  resolvePermission: (requestId: string, allow: boolean) => void
}

/**
 * Convert flat timeline entries from the daemon into grouped ChatMessages.
 *
 * Timeline entries are flat: user_message, assistant_message, reasoning,
 * tool_call, etc. We group consecutive non-user items into a single
 * assistant ChatMessage.
 */
function convertTimelineToMessages(
  payload: FetchAgentTimelinePayload,
): ChatMessage[] {
  const messages: ChatMessage[] = []
  let currentAssistant: ChatMessage | null = null

  function finalizeAssistant() {
    if (currentAssistant) {
      messages.push(currentAssistant)
      currentAssistant = null
    }
  }

  function ensureAssistant(timestamp: string): ChatMessage {
    if (!currentAssistant) {
      currentAssistant = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [],
        reasoning: "",
        createdAt: new Date(timestamp),
      }
    }
    return currentAssistant
  }

  for (const entry of payload.entries) {
    const item = entry.item
    const ts = entry.timestamp

    switch (item.type) {
      case "user_message":
        finalizeAssistant()
        messages.push({
          id: item.messageId ?? crypto.randomUUID(),
          role: "user",
          content: item.text,
          createdAt: new Date(ts),
        })
        break

      case "assistant_message": {
        const msg = ensureAssistant(ts)
        if (msg.content) msg.content += item.text
        else msg.content = item.text
        break
      }

      case "reasoning": {
        const msg = ensureAssistant(ts)
        msg.reasoning = (msg.reasoning ?? "") + item.text
        break
      }

      case "tool_call": {
        const msg = ensureAssistant(ts)
        const existing = msg.toolCalls?.find(
          (tc) => tc.toolCallId === item.callId,
        )
        if (existing) {
          existing.status = item.status
          existing.detail = item.detail as ToolCallDetail
          existing.error = item.error as string | null | undefined
        } else {
          msg.toolCalls = [
            ...(msg.toolCalls ?? []),
            {
              toolCallId: item.callId,
              toolName: item.name,
              status: item.status,
              detail: item.detail as ToolCallDetail,
              error: item.error as string | null | undefined,
            },
          ]
        }
        break
      }

      case "error": {
        const msg = ensureAssistant(ts)
        if (msg.content) msg.content += `\n\nError: ${item.message}`
        else msg.content = `Error: ${item.message}`
        break
      }

      // compaction, todo - skip
      default:
        break
    }
  }

  finalizeAssistant()
  return messages
}

export function useAgentChat(options: UseAgentChatOptions): UseAgentChatReturn {
  const { client, provider, cwd } = options
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agentId, setAgentId] = useState<string | null>(options.agentId ?? null)
  const [pendingPermission, setPendingPermission] =
    useState<PermissionRequest | null>(null)

  const cancelRef = useRef<(() => void) | null>(null)
  const currentAssistantRef = useRef<ChatMessage | null>(null)

  // Load existing timeline when selecting an agent with history
  useEffect(() => {
    if (!options.agentId) return

    let cancelled = false
    setIsLoadingHistory(true)

    client
      .fetchAgentTimeline(options.agentId, {
        direction: "tail",
        limit: 200,
        projection: "projected",
      })
      .then((payload) => {
        if (cancelled) return
        const history = convertTimelineToMessages(payload)
        setMessages(history)
      })
      .catch((err) => {
        if (cancelled) return
        setError(
          err instanceof Error ? err.message : "Failed to load chat history",
        )
      })
      .finally(() => {
        if (!cancelled) setIsLoadingHistory(false)
      })

    return () => {
      cancelled = true
    }
  }, [options.agentId, client])

  // Subscribe to live events for the current agent (handles ongoing/new streams)
  useEffect(() => {
    const currentId = agentId
    if (!currentId) return

    const unsubscribe = client.subscribe((event: DaemonEvent) => {
      // Handle agent_stream events for our agent
      if (event.type === "agent_stream" && event.agentId === currentId) {
        // Only process if we're not already processing via processStream
        if (currentAssistantRef.current) return

        const parts = mapDaemonEventToStreamParts(event)
        for (const part of parts) {
          switch (part.type) {
            case "text-delta":
            case "reasoning-delta":
            case "tool-call-start":
            case "tool-call-result":
              // These arrive via live subscription when another client
              // triggers the agent. For now, mark as streaming and let
              // the next timeline fetch pick up the full result.
              setIsStreaming(true)
              break

            case "finish":
              setIsStreaming(false)
              // Refresh timeline to get the complete response
              client
                .fetchAgentTimeline(currentId, {
                  direction: "tail",
                  limit: 200,
                  projection: "projected",
                })
                .then((payload) => {
                  setMessages(convertTimelineToMessages(payload))
                })
                .catch(() => {})
              break

            case "error":
              setIsStreaming(false)
              setError(part.error)
              break
          }
        }
      }

      // Handle permission events
      if (
        event.type === "agent_permission_request" &&
        event.agentId === currentId
      ) {
        setPendingPermission({
          id: event.request.id,
          agentId: currentId,
          name: event.request.name,
          kind: event.request.kind,
          title: event.request.title,
          description: event.request.description,
          input: event.request.input,
        })
      }

      if (
        event.type === "agent_permission_resolved" &&
        event.agentId === currentId
      ) {
        setPendingPermission(null)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [agentId, client])

  const processStream = useCallback(
    async (stream: ReadableStream<ChatStreamPart>) => {
      const reader = stream.getReader()

      // Create a new assistant message
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [],
        reasoning: "",
        createdAt: new Date(),
      }
      currentAssistantRef.current = assistantMsg
      setMessages((prev) => [...prev, assistantMsg])

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const part = value

          switch (part.type) {
            case "text-delta":
              assistantMsg.content += part.textDelta
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id ? { ...assistantMsg } : m,
                ),
              )
              break

            case "reasoning-delta":
              assistantMsg.reasoning =
                (assistantMsg.reasoning ?? "") + part.textDelta
              // Don't re-render on every reasoning chunk (perf)
              break

            case "tool-call-start": {
              // Will be followed by tool-call-result with "running" status
              break
            }

            case "tool-call-result": {
              const existing = assistantMsg.toolCalls?.find(
                (tc) => tc.toolCallId === part.toolCallId,
              )
              if (existing) {
                existing.status = part.status
                existing.detail = part.detail
                existing.error = part.error
              } else {
                assistantMsg.toolCalls = [
                  ...(assistantMsg.toolCalls ?? []),
                  {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    status: part.status,
                    detail: part.detail,
                    error: part.error,
                  },
                ]
              }
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id ? { ...assistantMsg } : m,
                ),
              )
              break
            }

            case "step-finish":
              assistantMsg.usage = part.usage
              break

            case "permission-request":
              if (agentId) {
                setPendingPermission({
                  id: part.id,
                  agentId,
                  name: part.name,
                  kind: part.kind,
                  title: part.title,
                  description: part.description,
                  input: part.input,
                })
              }
              break

            case "permission-resolved":
              setPendingPermission(null)
              break

            case "error":
              setError(part.error)
              break

            case "finish":
              // Final render with reasoning
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id ? { ...assistantMsg } : m,
                ),
              )
              break
          }
        }
      } finally {
        reader.releaseLock()
        currentAssistantRef.current = null
        setIsStreaming(false)
      }
    },
    [agentId],
  )

  const send = useCallback(
    async (text: string) => {
      if (isStreaming) return

      setError(null)
      setIsStreaming(true)

      // Add user message
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        createdAt: new Date(),
      }
      setMessages((prev) => [...prev, userMsg])

      try {
        if (!agentId) {
          // Create agent with initial prompt
          const result = await createAgentAndStream({
            client,
            provider,
            cwd,
            initialPrompt: text,
          })
          setAgentId(result.agentId)
          cancelRef.current = result.cancel
          await processStream(result.stream)
        } else {
          // Send message to existing agent
          const result = sendMessageToAgent({
            client,
            agentId,
            text,
          })
          cancelRef.current = result.cancel
          await processStream(result.stream)
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to send message",
        )
        setIsStreaming(false)
      }
    },
    [isStreaming, agentId, client, provider, cwd, processStream],
  )

  const stop = useCallback(() => {
    cancelRef.current?.()
    cancelRef.current = null
    setIsStreaming(false)
  }, [])

  const resolvePermission = useCallback(
    (requestId: string, allow: boolean) => {
      if (!agentId) return
      client.respondToPermission(
        agentId,
        requestId,
        allow
          ? { behavior: "allow" }
          : { behavior: "deny" },
      )
      setPendingPermission(null)
    },
    [agentId, client],
  )

  return {
    messages,
    isStreaming,
    isLoadingHistory,
    error,
    agentId,
    pendingPermission,
    send,
    stop,
    resolvePermission,
  }
}
