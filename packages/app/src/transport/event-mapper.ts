/**
 * Maps daemon AgentStreamEventPayload to UI-consumable stream parts.
 *
 * This is the bridge between Junction's daemon protocol and the chat UI.
 */

import type { DaemonEvent } from "@server/client/daemon-client"

/**
 * Structured tool call detail from the daemon.
 * Each type carries domain-specific fields for rendering.
 */
export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | { type: "search"; query: string }
  | { type: "sub_agent"; subAgentType?: string; description?: string; log: string }
  | { type: "plain_text"; label?: string; text?: string }
  | { type: "unknown"; input?: unknown; output?: unknown }

export type ChatStreamPart =
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning-delta"; textDelta: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string }
  | {
      type: "tool-call-result"
      toolCallId: string
      toolName: string
      status: "running" | "completed" | "failed" | "canceled"
      detail: ToolCallDetail
      error?: string | null
    }
  | { type: "step-start" }
  | {
      type: "step-finish"
      usage?: { inputTokens?: number; outputTokens?: number; totalCostUsd?: number }
    }
  | { type: "error"; error: string }
  | { type: "finish" }
  | {
      type: "permission-request"
      id: string
      name: string
      kind: string
      title?: string
      description?: string
      input?: Record<string, unknown>
    }
  | { type: "permission-resolved"; requestId: string }

/**
 * Convert a daemon agent_stream event into zero or more ChatStreamParts.
 * Returns an array because one daemon event may produce multiple UI parts.
 */
export function mapDaemonEventToStreamParts(
  event: Extract<DaemonEvent, { type: "agent_stream" }>,
): ChatStreamPart[] {
  const payload = event.event
  const parts: ChatStreamPart[] = []

  switch (payload.type) {
    case "turn_started":
      parts.push({ type: "step-start" })
      break

    case "turn_completed":
      parts.push({
        type: "step-finish",
        usage: payload.usage
          ? {
              inputTokens: payload.usage.inputTokens ?? undefined,
              outputTokens: payload.usage.outputTokens ?? undefined,
              totalCostUsd: payload.usage.totalCostUsd ?? undefined,
            }
          : undefined,
      })
      parts.push({ type: "finish" })
      break

    case "turn_failed":
      parts.push({ type: "error", error: payload.error })
      break

    case "turn_canceled":
      parts.push({ type: "finish" })
      break

    case "timeline": {
      const item = payload.item
      switch (item.type) {
        case "assistant_message":
          parts.push({ type: "text-delta", textDelta: item.text })
          break

        case "reasoning":
          parts.push({ type: "reasoning-delta", textDelta: item.text })
          break

        case "tool_call":
          if (item.status === "running") {
            parts.push({
              type: "tool-call-start",
              toolCallId: item.callId,
              toolName: item.name,
            })
          }
          parts.push({
            type: "tool-call-result",
            toolCallId: item.callId,
            toolName: item.name,
            status: item.status,
            detail: item.detail as ToolCallDetail,
            error: item.error as string | null | undefined,
          })
          break

        case "error":
          parts.push({ type: "error", error: item.message })
          break

        // user_message, todo, compaction - no UI stream parts needed
        default:
          break
      }
      break
    }

    case "permission_requested":
      parts.push({
        type: "permission-request",
        id: payload.request.id,
        name: payload.request.name,
        kind: payload.request.kind,
        title: payload.request.title,
        description: payload.request.description,
        input: payload.request.input,
      })
      break

    case "permission_resolved":
      parts.push({
        type: "permission-resolved",
        requestId: payload.requestId,
      })
      break

    // thread_started, attention_required - no stream parts needed
    default:
      break
  }

  return parts
}
