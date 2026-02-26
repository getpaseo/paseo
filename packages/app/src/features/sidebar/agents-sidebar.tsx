import { useState, useEffect, useMemo, useCallback } from "react"
import { useAtom, useSetAtom } from "jotai"
import { Plus, Search, PanelLeftClose, X, Settings } from "lucide-react"
import type { AgentSnapshotPayload } from "@server/shared/messages"
import { useDaemonStore } from "@/stores/daemon-store"
import {
  sidebarOpenAtom,
  selectedAgentAtom,
  showNewChatFormAtom,
  pendingNewChatAtom,
  collapsedDaemonsAtom,
  daemonFilterAtom,
} from "@/lib/atoms"
import { cn } from "@/lib/cn"
import { Button } from "@/components/ui/button"
import { DaemonGroup } from "@/features/sidebar/daemon-group"
import { AgentItem, type AgentEntry } from "@/features/sidebar/agent-item"
import { AddDaemonDialog } from "@/features/sidebar/add-daemon-dialog"
import { signOut, useSession } from "@/lib/auth-client"

function toEntry(
  snapshot: AgentSnapshotPayload,
  daemonId: string,
  daemonLabel: string,
): AgentEntry {
  return {
    id: snapshot.id,
    title: snapshot.title,
    status: snapshot.status,
    provider: snapshot.provider,
    cwd: snapshot.cwd,
    createdAt: snapshot.createdAt,
    daemonId,
    daemonLabel,
  }
}

export function AgentsSidebar() {
  const profiles = useDaemonStore((s) => s.profiles)
  const connections = useDaemonStore((s) => s.connections)
  const addConnection = useDaemonStore((s) => s.addConnection)
  const removeConnection = useDaemonStore((s) => s.removeConnection)
  const reconnect = useDaemonStore((s) => s.reconnect)

  const setSidebarOpen = useSetAtom(sidebarOpenAtom)
  const [selectedAgent, setSelectedAgent] = useAtom(selectedAgentAtom)
  const setShowNewChatForm = useSetAtom(showNewChatFormAtom)
  const setPendingNewChat = useSetAtom(pendingNewChatAtom)
  const [collapsedDaemons, setCollapsedDaemons] = useAtom(collapsedDaemonsAtom)
  const [daemonFilter] = useAtom(daemonFilterAtom)

  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [addDaemonOpen, setAddDaemonOpen] = useState(false)

  const { data: session } = useSession()

  // Fetch agents from ALL connected daemons
  useEffect(() => {
    const cleanups: (() => void)[] = []

    for (const profile of profiles) {
      const conn = connections.get(profile.id)
      if (!conn || conn.status !== "connected") continue
      const client = conn.client
      const daemonId = profile.id
      const daemonLabel = profile.label

      // Fetch initial agent list
      client
        .fetchAgents()
        .then((result) => {
          const entries = result.entries.map((e) =>
            toEntry(e.agent, daemonId, daemonLabel),
          )
          setAgents((prev) => {
            // Remove old entries from this daemon, add new
            const other = prev.filter((a) => a.daemonId !== daemonId)
            return [...other, ...entries]
          })
        })
        .catch(() => {})

      // Subscribe to live updates
      const off = client.on("agent_update", (msg) => {
        if (msg.type !== "agent_update") return
        const payload = msg.payload as
          | { kind: "upsert"; agent: AgentSnapshotPayload }
          | { kind: "remove"; agentId: string }

        if (payload.kind === "upsert") {
          const entry = toEntry(payload.agent, daemonId, daemonLabel)
          setAgents((prev) => {
            const idx = prev.findIndex(
              (a) => a.id === entry.id && a.daemonId === daemonId,
            )
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = entry
              return next
            }
            return [...prev, entry]
          })
        } else if (payload.kind === "remove") {
          setAgents((prev) =>
            prev.filter(
              (a) =>
                !(a.id === payload.agentId && a.daemonId === daemonId),
            ),
          )
        }
      })

      cleanups.push(off)
    }

    return () => {
      cleanups.forEach((fn) => fn())
    }
  }, [profiles, connections])

  // Remove agents from disconnected daemons
  useEffect(() => {
    const connectedIds = new Set(
      profiles
        .filter((p) => connections.get(p.id)?.status === "connected")
        .map((p) => p.id),
    )
    setAgents((prev) => prev.filter((a) => connectedIds.has(a.daemonId)))
  }, [connections, profiles])

  // Group agents by daemon, sorted newest first
  const agentsByDaemon = useMemo(() => {
    const filtered =
      daemonFilter.length > 0
        ? agents.filter((a) => daemonFilter.includes(a.daemonId))
        : agents

    const searched = searchQuery
      ? filtered.filter((a) => {
          const q = searchQuery.toLowerCase()
          return (
            a.title?.toLowerCase().includes(q) ||
            a.id.includes(q) ||
            a.provider.includes(q) ||
            a.cwd.toLowerCase().includes(q)
          )
        })
      : filtered

    const grouped = new Map<string, AgentEntry[]>()
    for (const agent of searched) {
      const list = grouped.get(agent.daemonId) ?? []
      list.push(agent)
      grouped.set(agent.daemonId, list)
    }

    // Sort each group by createdAt descending
    for (const list of grouped.values()) {
      list.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
    }

    return grouped
  }, [agents, daemonFilter, searchQuery])

  const handleSelectAgent = useCallback(
    (agentId: string, daemonId: string) => {
      setSelectedAgent({ agentId, daemonId })
      setShowNewChatForm(false)
    },
    [setSelectedAgent, setShowNewChatForm],
  )

  const handleDeleteAgent = useCallback(
    (agentId: string, daemonId: string) => {
      const conn = connections.get(daemonId)
      if (!conn) return
      conn.client.deleteAgent(agentId).catch(() => {})
      setAgents((prev) =>
        prev.filter(
          (a) => !(a.id === agentId && a.daemonId === daemonId),
        ),
      )
      if (
        selectedAgent?.agentId === agentId &&
        selectedAgent?.daemonId === daemonId
      ) {
        setSelectedAgent(null)
      }
    },
    [connections, selectedAgent, setSelectedAgent],
  )

  const toggleCollapse = useCallback(
    (daemonId: string) => {
      setCollapsedDaemons((prev) =>
        prev.includes(daemonId)
          ? prev.filter((id) => id !== daemonId)
          : [...prev, daemonId],
      )
    },
    [setCollapsedDaemons],
  )

  const handleNewChatOnDaemon = useCallback(
    (daemonId: string) => {
      setSelectedAgent(null)
      setShowNewChatForm(true)
      // Store the target daemon so NewChatForm knows which daemon to use
      // For now, we set the active connection to this daemon
      useDaemonStore.getState().setActiveConnection(daemonId)
    },
    [setSelectedAgent, setShowNewChatForm],
  )

  const handleAddDaemon = useCallback(
    async (url: string, label: string) => {
      await addConnection(url, label)
    },
    [addConnection],
  )

  const totalAgents = agents.length

  return (
    <div className="flex flex-col h-full select-none">
      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">Daemons</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={() => setAddDaemonOpen(true)}
            title="Add daemon"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Search (only when > 3 total agents) */}
      {totalAgents > 3 && (
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

      {/* Daemon groups + agent list */}
      <div className="flex-1 overflow-y-auto px-1">
        {profiles.length === 0 ? (
          <div className="px-2 py-8 text-center">
            <p className="text-xs text-muted-foreground mb-2">
              No daemons connected
            </p>
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              onClick={() => setAddDaemonOpen(true)}
            >
              <Plus className="h-3 w-3 mr-1" />
              Add daemon
            </Button>
          </div>
        ) : (
          profiles.map((profile) => {
            const conn = connections.get(profile.id)
            const status = conn?.status ?? "disconnected"
            const daemonAgents = agentsByDaemon.get(profile.id) ?? []
            const isCollapsed = collapsedDaemons.includes(profile.id)

            return (
              <DaemonGroup
                key={profile.id}
                profile={profile}
                status={status}
                agentCount={daemonAgents.length}
                isCollapsed={isCollapsed}
                onToggleCollapse={() => toggleCollapse(profile.id)}
                onNewChat={() => handleNewChatOnDaemon(profile.id)}
                onSettings={() => {
                  // TODO: open daemon-specific settings
                }}
                onRename={() => {
                  // TODO: inline rename
                }}
                onDisconnect={() => {
                  const conn = connections.get(profile.id)
                  if (conn) {
                    conn.unsubscribe?.()
                    conn.client.close().catch(() => {})
                    // Remove from connections but keep profile
                    const newConns = new Map(connections)
                    newConns.delete(profile.id)
                    // We can't directly set connections, so use reconnect pattern
                  }
                }}
                onRemove={() => removeConnection(profile.id)}
              >
                {daemonAgents.length === 0 ? (
                  <div className="px-2 py-2">
                    <span className="text-[10px] text-muted-foreground">
                      {status === "connected"
                        ? "No agents"
                        : status === "connecting"
                          ? "Connecting..."
                          : "Offline"}
                    </span>
                  </div>
                ) : (
                  daemonAgents.map((agent) => (
                    <AgentItem
                      key={`${agent.daemonId}-${agent.id}`}
                      agent={agent}
                      isSelected={
                        selectedAgent?.agentId === agent.id &&
                        selectedAgent?.daemonId === agent.daemonId
                      }
                      onSelect={() =>
                        handleSelectAgent(agent.id, agent.daemonId)
                      }
                      onDelete={() =>
                        handleDeleteAgent(agent.id, agent.daemonId)
                      }
                    />
                  ))
                )}
              </DaemonGroup>
            )
          })
        )}
      </div>

      {/* Footer — user info + settings */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border/50 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-5 h-5 rounded-full bg-foreground/10 flex items-center justify-center text-[10px] font-medium flex-shrink-0">
            {session?.user?.name?.charAt(0).toUpperCase() ?? "?"}
          </span>
          <span className="text-[10px] text-muted-foreground truncate">
            {session?.user?.name ?? session?.user?.email ?? ""}
          </span>
        </div>
        <button
          type="button"
          onClick={() => signOut()}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex-shrink-0"
        >
          Sign out
        </button>
      </div>

      <AddDaemonDialog
        open={addDaemonOpen}
        onOpenChange={setAddDaemonOpen}
        onAdd={handleAddDaemon}
      />
    </div>
  )
}
