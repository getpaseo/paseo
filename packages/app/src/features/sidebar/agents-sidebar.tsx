import { useState, useEffect, useMemo, useCallback } from "react"
import { useAtom, useSetAtom } from "jotai"
import { formatDistanceToNow } from "date-fns"
import { Plus, Search, PanelLeftClose, X } from "lucide-react"
import type { AgentSnapshotPayload } from "@server/shared/messages"
import { useDaemonStore } from "@/stores/daemon-store"
import { sidebarOpenAtom, selectedAgentIdAtom, showNewChatFormAtom } from "@/lib/atoms"
import { cn } from "@/lib/cn"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu"

interface AgentEntry {
  id: string
  title: string | null
  status: string
  provider: string
  cwd: string
  createdAt: string
}

const STATUS_DOT: Record<string, string> = {
  initializing: "bg-yellow-500 animate-pulse",
  idle: "bg-green-500",
  running: "bg-blue-500 animate-pulse",
  error: "bg-red-500",
  closed: "bg-muted-foreground",
}

function toEntry(snapshot: AgentSnapshotPayload): AgentEntry {
  return {
    id: snapshot.id,
    title: snapshot.title,
    status: snapshot.status,
    provider: snapshot.provider,
    cwd: snapshot.cwd,
    createdAt: snapshot.createdAt,
  }
}

export function AgentsSidebar() {
  const client = useDaemonStore((s) => s.getActiveClient())
  const activeConnectionId = useDaemonStore((s) => s.activeConnectionId)
  const connections = useDaemonStore((s) => s.connections)
  const removeConnection = useDaemonStore((s) => s.removeConnection)
  const profiles = useDaemonStore((s) => s.profiles)

  const setSidebarOpen = useSetAtom(sidebarOpenAtom)
  const [selectedAgentId, setSelectedAgentId] = useAtom(selectedAgentIdAtom)
  const setShowNewChatForm = useSetAtom(showNewChatFormAtom)

  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [loading, setLoading] = useState(true)

  // Connection status
  const connectionStatus = activeConnectionId
    ? connections.get(activeConnectionId)?.status ?? "disconnected"
    : "disconnected"

  const activeProfile = activeConnectionId
    ? profiles.find((p) => p.id === activeConnectionId)
    : null

  // Fetch agents and subscribe to live updates
  useEffect(() => {
    if (!client) {
      setAgents([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    client
      .fetchAgents()
      .then((result) => {
        if (cancelled) return
        const entries = result.entries.map((e) => toEntry(e.agent))
        // Sort by createdAt descending (newest first)
        entries.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        setAgents(entries)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    // Subscribe to agent updates
    const off = client.on("agent_update", (msg) => {
      if (msg.type !== "agent_update") return
      const payload = msg.payload as
        | { kind: "upsert"; agent: AgentSnapshotPayload }
        | { kind: "remove"; agentId: string }

      if (payload.kind === "upsert") {
        const entry = toEntry(payload.agent)
        setAgents((prev) => {
          const idx = prev.findIndex((a) => a.id === entry.id)
          let next: AgentEntry[]
          if (idx >= 0) {
            next = [...prev]
            next[idx] = entry
          } else {
            next = [entry, ...prev]
          }
          // Re-sort by createdAt descending
          next.sort(
            (a, b) =>
              new Date(b.createdAt).getTime() -
              new Date(a.createdAt).getTime(),
          )
          return next
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

  // Filter agents by search query
  const filteredAgents = useMemo(() => {
    if (!searchQuery) return agents
    const q = searchQuery.toLowerCase()
    return agents.filter(
      (a) =>
        a.title?.toLowerCase().includes(q) ||
        a.id.includes(q) ||
        a.provider.includes(q),
    )
  }, [agents, searchQuery])

  const handleNewChat = useCallback(() => {
    setSelectedAgentId(null)
    setShowNewChatForm(true)
  }, [setSelectedAgentId, setShowNewChatForm])

  const handleSelectAgent = useCallback(
    (id: string) => {
      setSelectedAgentId(id)
      setShowNewChatForm(false)
    },
    [setSelectedAgentId, setShowNewChatForm],
  )

  const handleDeleteAgent = useCallback(
    (agentId: string) => {
      if (!client) return
      client.deleteAgent(agentId).catch(() => {})
      // Optimistically remove from list
      setAgents((prev) => prev.filter((a) => a.id !== agentId))
      // If it was selected, clear selection
      if (selectedAgentId === agentId) {
        setSelectedAgentId(null)
      }
    },
    [client, selectedAgentId, setSelectedAgentId],
  )

  const handleDisconnect = useCallback(() => {
    if (activeConnectionId) {
      removeConnection(activeConnectionId)
    }
  }, [activeConnectionId, removeConnection])

  const statusDotColor =
    connectionStatus === "connected"
      ? "bg-green-500"
      : connectionStatus === "connecting"
        ? "bg-yellow-500 animate-pulse"
        : "bg-muted-foreground"

  return (
    <div className="flex flex-col h-full select-none">
      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">
            Junction
          </span>
          <span
            className={cn("w-1.5 h-1.5 rounded-full", statusDotColor)}
            title={connectionStatus}
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={() => setSidebarOpen(false)}
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* New Chat button */}
      <div className="px-2 pb-2 flex-shrink-0">
        <button
          type="button"
          onClick={handleNewChat}
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs",
            "border border-border/50",
            "bg-foreground/5 hover:bg-foreground/10",
            "transition-colors duration-150 cursor-pointer",
          )}
        >
          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          <span>New Chat</span>
        </button>
      </div>

      {/* Search (only when > 3 agents) */}
      {agents.length > 3 && (
        <div className="px-2 pb-2 flex-shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search agents..."
              className={cn(
                "w-full pl-7 pr-7 py-1 rounded-md text-xs",
                "bg-foreground/5 border border-border/50",
                "placeholder:text-muted-foreground/60",
                "focus:outline-none focus:ring-1 focus:ring-ring",
              )}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto px-1">
        {loading ? (
          <div className="px-2 py-4 text-center">
            <span className="text-xs text-muted-foreground animate-pulse">
              Loading agents...
            </span>
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="px-2 py-4 text-center">
            <span className="text-xs text-muted-foreground">
              {searchQuery ? "No matching agents" : "No agents yet"}
            </span>
          </div>
        ) : (
          filteredAgents.map((agent) => (
            <ContextMenu key={agent.id}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  onClick={() => handleSelectAgent(agent.id)}
                  className={cn(
                    "flex items-start gap-2 w-full px-2 py-1.5 rounded-md cursor-pointer text-left",
                    "transition-colors duration-150",
                    "hover:bg-foreground/5",
                    selectedAgentId === agent.id && "bg-foreground/10",
                  )}
                >
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0",
                      STATUS_DOT[agent.status] ?? "bg-muted-foreground",
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">
                      {agent.title ?? `Agent ${agent.id.slice(0, 8)}`}
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {agent.provider}
                      {" \u00b7 "}
                      {formatDistanceToNow(new Date(agent.createdAt), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => handleDeleteAgent(agent.id)}
                >
                  Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))
        )}
      </div>

      {/* Footer */}
      {activeProfile && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-border/50 flex-shrink-0">
          <span className="text-[10px] text-muted-foreground truncate max-w-[70%]">
            {activeProfile.url}
          </span>
          <button
            type="button"
            onClick={handleDisconnect}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  )
}
