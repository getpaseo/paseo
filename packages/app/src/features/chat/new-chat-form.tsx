import { useState, useRef, useEffect } from "react"
import { useSetAtom } from "jotai"
import type { DaemonClient } from "@server/client/daemon-client"
import {
  selectedAgentIdAtom,
  showNewChatFormAtom,
  pendingNewChatAtom,
} from "@/lib/atoms"
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
} from "@/components/ui/prompt-input"
import { Button } from "@/components/ui/button"
import { ArrowUp } from "lucide-react"
import { cn } from "@/lib/cn"

type AgentProvider = "claude" | "codex" | "opencode"

const CWD_STORAGE_KEY = "junction:cwd"
const PROVIDER_STORAGE_KEY = "junction:provider"

function getStoredCwd(): string {
  try {
    return localStorage.getItem(CWD_STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

function getStoredProvider(): AgentProvider {
  try {
    const val = localStorage.getItem(PROVIDER_STORAGE_KEY)
    if (val === "claude" || val === "codex" || val === "opencode") return val
  } catch {
    // ignore
  }
  return "claude"
}

export function NewChatForm({ client }: { client: DaemonClient }) {
  const [prompt, setPrompt] = useState("")
  const [provider, setProvider] = useState<AgentProvider>(getStoredProvider)
  const [cwd, setCwd] = useState(getStoredCwd)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const setSelectedAgentId = useSetAtom(selectedAgentIdAtom)
  const setShowNewChatForm = useSetAtom(showNewChatFormAtom)
  const setPendingNewChat = useSetAtom(pendingNewChatAtom)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleProviderChange = (value: AgentProvider) => {
    setProvider(value)
    try {
      localStorage.setItem(PROVIDER_STORAGE_KEY, value)
    } catch {}
  }

  const handleCwdChange = (value: string) => {
    setCwd(value)
    try {
      localStorage.setItem(CWD_STORAGE_KEY, value)
    } catch {}
  }

  const handleSubmit = () => {
    const text = prompt.trim()
    if (!text) return

    // Store config for ChatView to pick up
    setPendingNewChat({ provider, cwd, initialPrompt: text })
    setSelectedAgentId(null)
    setShowNewChatForm(false)
  }

  return (
    <div className="flex-1 flex items-center justify-center h-full">
      <div className="w-full max-w-2xl px-6">
        <div className="text-center mb-8">
          <h2 className="text-lg font-medium text-foreground">Junction</h2>
          <p className="text-sm text-muted-foreground mt-1">
            What would you like to work on?
          </p>
        </div>

        <PromptInput
          value={prompt}
          onValueChange={setPrompt}
          onSubmit={handleSubmit}
          className="rounded-xl border border-border bg-background shadow-sm"
        >
          <PromptInputTextarea
            ref={textareaRef}
            placeholder="Describe your task..."
            className="text-sm px-4 py-3"
          />
          <PromptInputActions className="px-3 pb-3 justify-between">
            <div className="flex items-center gap-2">
              <select
                value={provider}
                onChange={(e) =>
                  handleProviderChange(e.target.value as AgentProvider)
                }
                className={cn(
                  "px-2 py-1 text-[11px] rounded-md",
                  "border border-border/50 bg-foreground/5",
                  "focus:outline-none focus:ring-1 focus:ring-ring",
                  "cursor-pointer",
                )}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="opencode">OpenCode</option>
              </select>

              <input
                type="text"
                value={cwd}
                onChange={(e) => handleCwdChange(e.target.value)}
                placeholder="Working directory"
                className={cn(
                  "px-2 py-1 text-[11px] font-mono rounded-md w-48",
                  "border border-border/50 bg-foreground/5",
                  "placeholder:text-muted-foreground/50",
                  "focus:outline-none focus:ring-1 focus:ring-ring",
                )}
              />
            </div>

            <Button
              size="icon"
              className="h-7 w-7 rounded-lg"
              onClick={handleSubmit}
              disabled={!prompt.trim()}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          </PromptInputActions>
        </PromptInput>
      </div>
    </div>
  )
}
