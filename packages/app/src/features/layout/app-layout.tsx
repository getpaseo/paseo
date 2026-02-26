import { useState, useEffect } from "react"
import { useDaemonStore } from "@/stores/daemon-store"
import { ConnectionPanel } from "@/features/daemons/connection-panel"
import { ChatView } from "@/features/chat/chat-view"
import type { DaemonClient } from "@server/client/daemon-client"
import { cn } from "@/lib/cn"

const CWD_STORAGE_KEY = "junction:cwd"
const PROVIDER_STORAGE_KEY = "junction:provider"

type AgentProvider = "claude" | "codex" | "opencode"

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

interface AgentEntry {
  id: string
  title: string | null
  status: string
  provider: string
  cwd: string
}

function AgentList({
  client,
  selectedAgentId,
  onSelectAgent,
}: {
  client: DaemonClient
  selectedAgentId: string | null
  onSelectAgent: (id: string) => void
}) {
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    client
      .fetchAgents()
      .then((result) => {
        if (cancelled) return
        setAgents(
          result.entries.map((e) => ({
            id: e.agent.id,
            title: e.agent.title,
            status: e.agent.status,
            provider: e.agent.provider,
            cwd: e.agent.cwd,
          })),
        )
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    const off = client.on("agent_update", (msg) => {
      if (msg.type !== "agent_update") return
      const payload = msg.payload as
        | { kind: "upsert"; agent: { id: string; title: string | null; status: string; provider: string; cwd: string } }
        | { kind: "remove"; agentId: string }
      if (payload.kind === "upsert") {
        const { agent } = payload
        setAgents((prev) => {
          const idx = prev.findIndex((a) => a.id === agent.id)
          const entry: AgentEntry = {
            id: agent.id,
            title: agent.title,
            status: agent.status,
            provider: agent.provider,
            cwd: agent.cwd,
          }
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = entry
            return next
          }
          return [entry, ...prev]
        })
      } else if (payload.kind === "remove") {
        setAgents((prev) => prev.filter((a) => a.id !== payload.agentId))
      }
    })

    return () => {
      cancelled = true
      off()
    }
  }, [client])

  if (loading) {
    return (
      <p className="text-xs text-muted-foreground p-2 animate-pulse">
        Loading agents...
      </p>
    )
  }

  if (agents.length === 0) {
    return (
      <p className="text-xs text-muted-foreground p-2">
        No agents yet. Start a new chat.
      </p>
    )
  }

  return (
    <div className="space-y-0.5">
      {agents.map((agent) => {
        const cwdShort = agent.cwd.split("/").slice(-2).join("/")
        return (
          <button
            key={agent.id}
            onClick={() => onSelectAgent(agent.id)}
            className={cn(
              "w-full text-left px-2 py-1.5 rounded text-xs transition-colors",
              selectedAgentId === agent.id
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50",
            )}
          >
            <div className="font-medium truncate">
              {agent.title ?? agent.id.slice(0, 8)}
            </div>
            <div className="text-muted-foreground text-[10px] truncate">
              {agent.provider} · {agent.status} · {cwdShort}
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function AppLayout() {
  const activeConnectionId = useDaemonStore((s) => s.activeConnectionId)
  const connections = useDaemonStore((s) => s.connections)
  const profiles = useDaemonStore((s) => s.profiles)
  const getActiveClient = useDaemonStore((s) => s.getActiveClient)
  const addConnection = useDaemonStore((s) => s.addConnection)
  const removeConnection = useDaemonStore((s) => s.removeConnection)

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [isNewChat, setIsNewChat] = useState(false)
  const [cwd, setCwd] = useState(getStoredCwd)
  const [provider, setProvider] = useState<AgentProvider>(getStoredProvider)

  const activeConn = activeConnectionId
    ? connections.get(activeConnectionId)
    : null
  const isConnected = activeConn?.status === "connected"
  const client = getActiveClient()

  // Auto-reconnect: if we have persisted profiles but no live connections, reconnect
  useEffect(() => {
    if (profiles.length > 0 && connections.size === 0) {
      // Reconnect the first profile
      const profile = profiles[0]
      addConnection(profile.url, profile.label).catch(() => {})
    }
  }, []) // Only on mount

  const handleCwdChange = (value: string) => {
    setCwd(value)
    try {
      localStorage.setItem(CWD_STORAGE_KEY, value)
    } catch {}
  }

  const handleProviderChange = (value: AgentProvider) => {
    setProvider(value)
    try {
      localStorage.setItem(PROVIDER_STORAGE_KEY, value)
    } catch {}
  }

  if (connections.size === 0 || !activeConnectionId) {
    return <ConnectionPanel />
  }

  const handleNewChat = () => {
    setSelectedAgentId(null)
    setIsNewChat(true)
  }

  const handleSelectAgent = (id: string) => {
    setSelectedAgentId(id)
    setIsNewChat(false)
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-[var(--sidebar-width,240px)] border-r border-border flex flex-col bg-background">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <h1 className="text-sm font-semibold">Junction</h1>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-block w-2 h-2 rounded-full",
                isConnected
                  ? "bg-green-500"
                  : "bg-yellow-500 animate-pulse",
              )}
              title={activeConn?.status ?? "unknown"}
            />
          </div>
        </div>

        <div className="p-2 space-y-2">
          <button
            onClick={handleNewChat}
            disabled={!isConnected}
            className={cn(
              "w-full px-2 py-1.5 text-xs rounded border border-dashed border-border",
              "hover:bg-accent transition-colors",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            + New Chat
          </button>

          <div className="space-y-1">
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Provider
            </label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value as AgentProvider)}
              className="w-full px-2 py-1 text-[11px] rounded border border-border bg-muted/50 focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Working Dir
            </label>
            <input
              type="text"
              value={cwd}
              onChange={(e) => handleCwdChange(e.target.value)}
              placeholder="/path/to/project"
              className="w-full px-2 py-1 text-[11px] font-mono rounded border border-border bg-muted/50 placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {client && isConnected ? (
            <AgentList
              client={client}
              selectedAgentId={selectedAgentId}
              onSelectAgent={handleSelectAgent}
            />
          ) : (
            <p className="text-xs text-muted-foreground p-2">
              Connecting to daemon...
            </p>
          )}
        </div>

        <div className="p-2 border-t border-border">
          <button
            onClick={() => removeConnection(activeConnectionId)}
            className="w-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Disconnect
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0">
        {client && isConnected && (isNewChat || selectedAgentId) ? (
          <ChatView
            key={selectedAgentId ?? "new"}
            client={client}
            agentId={selectedAgentId ?? undefined}
            provider={provider}
            cwd={cwd || undefined}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <p className="text-lg font-medium">Junction</p>
              <p className="text-sm mt-1">
                {isConnected
                  ? "Start a new chat or select an existing agent."
                  : "Connecting to daemon..."}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
