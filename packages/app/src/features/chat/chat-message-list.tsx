import { useEffect, useRef } from "react"
import type { ChatMessage, PermissionRequest } from "./use-agent-chat"
import { ToolCallItem } from "./tool-call-item"
import { ChatMarkdown } from "@/components/chat-markdown"
import { cn } from "@/lib/cn"

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-3.5 py-2 text-sm">
        {message.content}
      </div>
    </div>
  )
}

function AssistantMessage({
  message,
  isStreaming,
}: {
  message: ChatMessage
  isStreaming: boolean
}) {
  const hasContent = message.content.length > 0
  const hasToolCalls = (message.toolCalls?.length ?? 0) > 0
  const isActive = isStreaming && !hasContent && !hasToolCalls

  return (
    <div className="max-w-[95%]">
      {isActive && (
        <div className="flex items-center gap-2 py-2">
          <div className="flex gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/30 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/30 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-foreground/30 animate-bounce [animation-delay:300ms]" />
          </div>
          <span className="text-xs text-muted-foreground">Thinking...</span>
        </div>
      )}

      {hasContent && (
        <ChatMarkdown
          content={message.content}
          isStreaming={isStreaming && !hasToolCalls}
          className="text-sm"
        />
      )}

      {hasToolCalls && (
        <div className="mt-2 space-y-1">
          {message.toolCalls!.map((tc) => (
            <ToolCallItem key={tc.toolCallId} toolCall={tc} />
          ))}
        </div>
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
}

function PermissionBanner({
  permission,
  onResolve,
}: {
  permission: PermissionRequest
  onResolve: (requestId: string, allow: boolean) => void
}) {
  return (
    <div className="border border-yellow-500/30 bg-yellow-500/5 rounded-lg p-3 my-2">
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
  const isLastMessageIndex = messages.length - 1

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Only auto-scroll if already near bottom
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
          <p className="text-sm mt-1">Send a message to get started.</p>
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
                isStreaming={isStreaming && i === isLastMessageIndex}
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
