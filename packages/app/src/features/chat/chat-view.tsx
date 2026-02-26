import { useState, useEffect, useRef } from "react"
import { useSetAtom } from "jotai"
import type { DaemonClient } from "@server/client/daemon-client"
import type { AgentSnapshotPayload } from "@server/shared/messages"
import { selectedAgentAtom } from "@/lib/atoms"
import { useAgentChat } from "./use-agent-chat"
import { ChatMessageList } from "./chat-message-list"
import { ChatInput } from "./chat-input"
import { cn } from "@/lib/cn"

function ChatHeader({
  agent,
  isStreaming,
}: {
  agent: AgentSnapshotPayload | null
  isStreaming: boolean
}) {
  if (!agent) return null

  const statusColor: Record<string, string> = {
    initializing: "bg-yellow-500 animate-pulse",
    idle: "bg-green-500",
    running: "bg-blue-500 animate-pulse",
    error: "bg-red-500",
    closed: "bg-muted-foreground",
  }
  const dotClass = statusColor[agent.status] ?? "bg-muted-foreground"

  return (
    <div className="flex items-center gap-3 px-4 h-10 border-b border-border bg-background flex-shrink-0">
      <span
        className={cn("w-2 h-2 rounded-full flex-shrink-0", dotClass)}
        title={agent.status}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">
          {agent.title ?? `Agent ${agent.id.slice(0, 8)}`}
        </p>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-wide">{agent.provider}</span>
        {agent.model && <span>{agent.model}</span>}
        {isStreaming && (
          <span className="text-blue-500 font-medium">Streaming</span>
        )}
      </div>
    </div>
  )
}

export function ChatView({
  client,
  agentId,
  daemonId,
  provider,
  cwd,
  initialPrompt,
  onAgentCreated,
}: {
  client: DaemonClient
  agentId?: string
  daemonId: string
  provider?: "claude" | "codex" | "opencode"
  cwd?: string
  initialPrompt?: string
  onAgentCreated?: (agentId: string) => void
}) {
  const chat = useAgentChat({ client, agentId, provider, cwd })
  const [agent, setAgent] = useState<AgentSnapshotPayload | null>(null)
  const setSelectedAgent = useSetAtom(selectedAgentAtom)
  const autoSentRef = useRef(false)

  // Auto-send initial prompt (from NewChatForm)
  useEffect(() => {
    if (initialPrompt && !autoSentRef.current) {
      autoSentRef.current = true
      chat.send(initialPrompt)
    }
  }, [initialPrompt])

  // When agent is created, update the selected agent ID
  useEffect(() => {
    if (chat.agentId && !agentId) {
      setSelectedAgent({ agentId: chat.agentId, daemonId })
      onAgentCreated?.(chat.agentId)
    }
  }, [chat.agentId])

  // Fetch agent snapshot when viewing an existing agent
  useEffect(() => {
    const id = agentId ?? chat.agentId
    if (!id) return
    let cancelled = false

    client
      .fetchAgent(id)
      .then((result) => {
        if (cancelled || !result) return
        setAgent(result.agent)
      })
      .catch(() => {})

    const off = client.on("agent_update", (msg) => {
      if (msg.type !== "agent_update") return
      const payload = msg.payload as
        | { kind: "upsert"; agent: AgentSnapshotPayload }
        | { kind: "remove"; agentId: string }
      if (payload.kind === "upsert" && payload.agent.id === id) {
        setAgent(payload.agent)
      }
    })

    return () => {
      cancelled = true
      off()
    }
  }, [agentId, chat.agentId, client])

  return (
    <div className="flex flex-col h-full">
      <ChatHeader agent={agent} isStreaming={chat.isStreaming} />
      {chat.isLoadingHistory ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground animate-pulse">
            Loading conversation...
          </p>
        </div>
      ) : (
        <ChatMessageList
          messages={chat.messages}
          isStreaming={chat.isStreaming}
          error={chat.error}
          pendingPermission={chat.pendingPermission}
          onResolvePermission={chat.resolvePermission}
        />
      )}
      <ChatInput
        onSend={chat.send}
        onStop={chat.stop}
        isStreaming={chat.isStreaming}
      />
    </div>
  )
}
