import { useState, useCallback } from "react"
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
} from "@/components/ui/prompt-input"
import { Button } from "@/components/ui/button"
import { ArrowUp, Square } from "lucide-react"
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

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming) return
    onSend(trimmed)
    setText("")
  }, [text, isStreaming, onSend])

  return (
    <div className="px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <PromptInput
          value={text}
          onValueChange={setText}
          onSubmit={handleSubmit}
          isLoading={isStreaming}
          disabled={disabled}
          className="rounded-xl border border-border bg-background shadow-sm"
        >
          <PromptInputTextarea
            placeholder="Send a message..."
            className="text-sm px-4 py-3"
          />
          <PromptInputActions className="px-3 pb-3 justify-between">
            <div />
            <div>
              {isStreaming ? (
                <Button
                  variant="destructive"
                  size="icon"
                  className={cn("h-7 w-7 rounded-lg")}
                  onClick={onStop}
                  aria-label="Stop"
                >
                  <Square className="size-3.5" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  className={cn("h-7 w-7 rounded-lg")}
                  disabled={!text.trim() || disabled}
                  onClick={handleSubmit}
                  aria-label="Send (Enter)"
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </PromptInputActions>
        </PromptInput>
      </div>
    </div>
  )
}
