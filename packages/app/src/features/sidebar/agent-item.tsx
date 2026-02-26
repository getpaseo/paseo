import { memo } from "react"
import { formatDistanceToNow } from "date-fns"
import { cn } from "@/lib/cn"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu"

const STATUS_DOT: Record<string, string> = {
  initializing: "bg-yellow-500 animate-pulse",
  idle: "bg-green-500",
  running: "bg-blue-500 animate-pulse",
  error: "bg-red-500",
  closed: "bg-muted-foreground",
}

export interface AgentEntry {
  id: string
  title: string | null
  status: string
  provider: string
  cwd: string
  createdAt: string
  daemonId: string
  daemonLabel: string
}

interface AgentItemProps {
  agent: AgentEntry
  isSelected: boolean
  onSelect: () => void
  onDelete: () => void
}

function getCwdBasename(cwd: string): string {
  const parts = cwd.replace(/\/$/, "").split("/")
  return parts[parts.length - 1] || cwd
}

export const AgentItem = memo(function AgentItem({
  agent,
  isSelected,
  onSelect,
  onDelete,
}: AgentItemProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            "flex items-start gap-2 w-full px-2 py-1.5 rounded-md cursor-pointer text-left",
            "transition-colors duration-150",
            "hover:bg-foreground/5",
            isSelected && "bg-foreground/10",
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
              {getCwdBasename(agent.cwd)}
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
          onClick={onDelete}
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
