import { useState, useCallback } from "react"
import { ChevronDown, Plus, Settings } from "lucide-react"
import type { DaemonProfile, ConnectionStatus } from "@/stores/daemon-store"
import { cn } from "@/lib/cn"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu"

// Stable color palette for daemon letter icons
const DAEMON_COLORS = [
  "bg-green-600",
  "bg-blue-600",
  "bg-purple-600",
  "bg-orange-600",
  "bg-pink-600",
  "bg-cyan-600",
  "bg-yellow-600",
  "bg-red-600",
]

function getDaemonColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  return DAEMON_COLORS[Math.abs(hash) % DAEMON_COLORS.length]
}

interface DaemonGroupProps {
  profile: DaemonProfile
  status: ConnectionStatus
  agentCount: number
  isCollapsed: boolean
  onToggleCollapse: () => void
  onNewChat: () => void
  onSettings: () => void
  onRename: () => void
  onDisconnect: () => void
  onRemove: () => void
  children: React.ReactNode
}

export function DaemonGroup({
  profile,
  status,
  agentCount,
  isCollapsed,
  onToggleCollapse,
  onNewChat,
  onSettings,
  onRename,
  onDisconnect,
  onRemove,
  children,
}: DaemonGroupProps) {
  const [hovered, setHovered] = useState(false)
  const letter = profile.label.charAt(0).toUpperCase()
  const colorClass = getDaemonColor(profile.id)

  const statusDotClass =
    status === "connected"
      ? "ring-2 ring-green-500/40"
      : status === "connecting"
        ? "ring-2 ring-yellow-500/40 animate-pulse"
        : "opacity-50"

  return (
    <div className="mb-1">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left",
              "hover:bg-foreground/5 transition-colors duration-150 cursor-pointer",
            )}
            onClick={onToggleCollapse}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            {/* Letter icon */}
            <span
              className={cn(
                "w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0",
                colorClass,
                statusDotClass,
              )}
            >
              {letter}
            </span>

            {/* Label + count */}
            <span className="text-xs font-semibold truncate flex-1 min-w-0">
              {profile.label}
            </span>
            <span className="text-[10px] text-muted-foreground flex-shrink-0">
              {agentCount}
            </span>

            {/* Hover actions */}
            {hovered && (
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <span
                  role="button"
                  className="p-0.5 rounded hover:bg-foreground/10 text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSettings()
                  }}
                >
                  <Settings className="h-3 w-3" />
                </span>
                <span
                  role="button"
                  className="p-0.5 rounded hover:bg-foreground/10 text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation()
                    onNewChat()
                  }}
                >
                  <Plus className="h-3 w-3" />
                </span>
              </div>
            )}

            {/* Collapse chevron (when not hovered) */}
            {!hovered && (
              <ChevronDown
                className={cn(
                  "h-3 w-3 text-muted-foreground transition-transform flex-shrink-0",
                  isCollapsed && "-rotate-90",
                )}
              />
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onRename}>Rename</ContextMenuItem>
          <ContextMenuItem onClick={onNewChat}>New chat</ContextMenuItem>
          {status === "connected" && (
            <ContextMenuItem onClick={onDisconnect}>
              Disconnect
            </ContextMenuItem>
          )}
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={onRemove}
          >
            Remove
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Agent list (collapsible) */}
      {!isCollapsed && <div className="ml-2">{children}</div>}
    </div>
  )
}
