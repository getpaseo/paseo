import React, { useEffect, useRef, memo, useState } from "react"
import type { ChatMessage, PermissionRequest } from "./use-agent-chat"
import { ToolCallItem } from "./tool-call-item"
import { ChatMarkdown } from "@/components/chat-markdown"
import { TextShimmer } from "@/components/ui/text-shimmer"
import { cn } from "@/lib/cn"
import { Copy, Check } from "lucide-react"

const UserMessage = memo(function UserMessage({
  message,
}: {
  message: ChatMessage
}) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] bg-input-background rounded-2xl px-4 py-2.5 text-sm">
        {message.content}
      </div>
    </div>
  )
})

const AssistantMessage = memo(
  function AssistantMessage({
    message,
    isStreaming,
  }: {
    message: ChatMessage
    isStreaming: boolean
  }) {
    const [copied, setCopied] = useState(false)
    const hasContent = message.content.length > 0
    const hasToolCalls = (message.toolCalls?.length ?? 0) > 0
    const isThinking = isStreaming && !hasContent && !hasToolCalls

    function handleCopy() {
      if (!message.content) return
      navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }

    return (
      <div className="group relative w-full">
        {isThinking && (
          <div className="py-2">
            <TextShimmer className="text-sm" duration={1.5}>
              Thinking...
            </TextShimmer>
          </div>
        )}

        {hasContent && (
          <ChatMarkdown
            content={message.content}
            isStreaming={isStreaming && !hasToolCalls}
            className="text-sm"
          />
        )}

        {hasToolCalls &&
          message.toolCalls!.map((tc) => (
            <ToolCallItem key={tc.toolCallId} toolCall={tc} />
          ))}

        {hasContent && !isStreaming && (
          <button
            onClick={handleCopy}
            className="absolute top-0 right-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
            aria-label="Copy message"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        )}

        {message.usage && !isStreaming && (
          <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
            {message.usage.inputTokens != null && (
              <span>{message.usage.inputTokens.toLocaleString()} in</span>
            )}
            {message.usage.outputTokens != null && (
              <span>{message.usage.outputTokens.toLocaleString()} out</span>
            )}
            {message.usage.totalCostUsd != null && (
              <span>${message.usage.totalCostUsd.toFixed(4)}</span>
            )}
          </div>
        )}
      </div>
    )
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content.length === next.message.content.length &&
    (prev.message.toolCalls?.length ?? 0) ===
      (next.message.toolCalls?.length ?? 0) &&
    prev.isStreaming === next.isStreaming,
)

function PermissionBanner({
  permission,
  onResolve,
}: {
  permission: PermissionRequest
  onResolve: (requestId: string, allow: boolean) => void
}) {
  return (
    <div className="border-l-2 border-yellow-500 bg-yellow-500/5 rounded-r-lg p-3 my-2">
      <div className="flex items-start gap-2">
        <span className="text-yellow-500 text-sm mt-0.5">!</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {permission.title ?? permission.name}
          </p>
          {permission.description && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {permission.description}
            </p>
          )}
          {permission.input &&
            Object.keys(permission.input).length > 0 && (
              <pre className="text-[11px] font-mono text-muted-foreground mt-1.5 bg-muted/50 rounded p-1.5 overflow-x-auto">
                {JSON.stringify(permission.input, null, 2)}
              </pre>
            )}
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => onResolve(permission.id, true)}
              className="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Allow
            </button>
            <button
              onClick={() => onResolve(permission.id, false)}
              className="px-3 py-1 text-xs rounded border border-border hover:bg-accent"
            >
              Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ChatMessageList({
  messages,
  isStreaming,
  error,
  pendingPermission,
  onResolvePermission,
}: {
  messages: ChatMessage[]
  isStreaming: boolean
  error: string | null
  pendingPermission: PermissionRequest | null
  onResolvePermission: (requestId: string, allow: boolean) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastMessageIndex = messages.length - 1

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const isNearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 150
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, isStreaming])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-lg font-medium">Junction</p>
          <p className="text-sm mt-1">Send a message to get started</p>
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
      <div className="max-w-3xl mx-auto space-y-4">
        {messages.map((message, i) => (
          <div
            key={message.id}
            className={cn(
              message.role === "user" && "flex justify-end",
            )}
          >
            {message.role === "user" ? (
              <UserMessage message={message} />
            ) : (
              <AssistantMessage
                message={message}
                isStreaming={isStreaming && i === lastMessageIndex}
              />
            )}
          </div>
        ))}

        {pendingPermission && (
          <PermissionBanner
            permission={pendingPermission}
            onResolve={onResolvePermission}
          />
        )}

        {error && (
          <div className="border border-red-500/30 bg-red-500/5 rounded-lg p-3 text-sm text-red-500">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
