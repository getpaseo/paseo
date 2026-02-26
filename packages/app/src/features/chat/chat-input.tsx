import { useState, useRef, useCallback, type KeyboardEvent } from "react"
import { cn } from "@/lib/cn"

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  disabled,
}: {
  onSend: (text: string) => void
  onStop: () => void
  isStreaming: boolean
  disabled?: boolean
}) {
  const [text, setText] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming) return
    onSend(trimmed)
    setText("")
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [text, isStreaming, onSend])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleInput = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 200) + "px"
  }, [])

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                handleInput()
              }}
              onKeyDown={handleKeyDown}
              placeholder="Send a message..."
              disabled={disabled}
              rows={1}
              className={cn(
                "w-full resize-none rounded-xl border border-border bg-muted/50 px-3.5 py-2.5 text-sm",
                "placeholder:text-muted-foreground",
                "focus:outline-none focus:ring-1 focus:ring-ring",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "min-h-[40px] max-h-[200px]",
              )}
            />
          </div>
          {isStreaming ? (
            <button
              onClick={onStop}
              className={cn(
                "flex-shrink-0 h-10 w-10 rounded-xl",
                "flex items-center justify-center",
                "bg-destructive text-destructive-foreground",
                "hover:bg-destructive/90 transition-colors",
              )}
              title="Stop"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="currentColor"
              >
                <rect x="2" y="2" width="10" height="10" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!text.trim() || disabled}
              className={cn(
                "flex-shrink-0 h-10 w-10 rounded-xl",
                "flex items-center justify-center",
                "bg-primary text-primary-foreground",
                "hover:bg-primary/90 transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
              title="Send (Enter)"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8 12V4M8 4L4 8M8 4L12 8" />
              </svg>
            </button>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
          Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
