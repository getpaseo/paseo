import React, { useState, memo } from "react"
import type { ToolCallInfo } from "./use-agent-chat"
import { TextShimmer } from "@/components/ui/text-shimmer"
import { cn } from "@/lib/cn"
import {
  Check,
  X,
  ChevronRight,
  Terminal,
  FileText,
  Search,
  Globe,
  Pencil,
  FileOutput,
  FileInput,
  Layers,
} from "lucide-react"
import { IconSpinner } from "@/components/ui/icons"
import type { ToolCallDetail } from "@/transport/event-mapper"
import type { LucideIcon } from "lucide-react"

// ---------------------------------------------------------------------------
// Tool metadata: icon, label, and title extraction per detail type
// ---------------------------------------------------------------------------

interface ToolMeta {
  icon: LucideIcon
  label: string
  getTitle: (detail: ToolCallDetail) => string
}

const TOOL_META: Record<string, ToolMeta> = {
  Bash: {
    icon: Terminal,
    label: "Bash",
    getTitle: (d) => {
      if (d.type === "shell") {
        return d.command || "Running command..."
      }
      return "Running command..."
    },
  },
  Read: {
    icon: FileInput,
    label: "Read",
    getTitle: (d) => {
      if (d.type === "read") return d.filePath || "Reading file..."
      return "Reading file..."
    },
  },
  Edit: {
    icon: Pencil,
    label: "Edit",
    getTitle: (d) => {
      if (d.type === "edit") return d.filePath || "Editing file..."
      return "Editing file..."
    },
  },
  Write: {
    icon: FileOutput,
    label: "Write",
    getTitle: (d) => {
      if (d.type === "write") return d.filePath || "Writing file..."
      return "Writing file..."
    },
  },
  Grep: {
    icon: Search,
    label: "Grep",
    getTitle: (d) => {
      if (d.type === "search") return d.query || "Searching..."
      return "Searching..."
    },
  },
  Glob: {
    icon: Search,
    label: "Glob",
    getTitle: (d) => {
      if (d.type === "search") return d.query || "Searching files..."
      return "Searching files..."
    },
  },
  Task: {
    icon: Layers,
    label: "Task",
    getTitle: (d) => {
      if (d.type === "sub_agent") return d.description || "Running sub-agent..."
      return "Running sub-agent..."
    },
  },
  WebSearch: {
    icon: Globe,
    label: "Web Search",
    getTitle: (d) => {
      if (d.type === "search") return d.query || "Searching web..."
      return "Searching web..."
    },
  },
  WebFetch: {
    icon: Globe,
    label: "Web Fetch",
    getTitle: (d) => {
      if (d.type === "plain_text") return d.label || "Fetching URL..."
      return "Fetching URL..."
    },
  },
}

function getToolMeta(toolName: string): ToolMeta {
  return (
    TOOL_META[toolName] ?? {
      icon: FileText,
      label: toolName,
      getTitle: () => toolName,
    }
  )
}

// ---------------------------------------------------------------------------
// Status icon (right-aligned)
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { status: ToolCallInfo["status"] }) {
  switch (status) {
    case "running":
      return <IconSpinner className="w-3.5 h-3.5 text-muted-foreground" />
    case "completed":
      return <Check className="w-3.5 h-3.5 text-green-500" />
    case "failed":
      return <X className="w-3.5 h-3.5 text-red-500" />
    case "canceled":
      return null
  }
}

// ---------------------------------------------------------------------------
// Check whether a tool call has expandable detail content
// ---------------------------------------------------------------------------

function hasDetailContent(toolCall: ToolCallInfo): boolean {
  const d = toolCall.detail
  switch (d.type) {
    case "shell":
      return !!(d.output || d.command || (d.exitCode != null && d.exitCode !== 0))
    case "edit":
      return !!d.unifiedDiff
    case "read":
      return !!d.content
    case "write":
      return !!d.filePath
    case "search":
      return !!d.query
    case "sub_agent":
      return !!d.log
    case "plain_text":
      return !!d.text
    case "unknown":
      return !!(d.input || d.output)
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Shell output with expandable line limit
// ---------------------------------------------------------------------------

function ShellDetail({
  command,
  output,
  exitCode,
}: {
  command: string
  output?: string
  exitCode?: number | null
}) {
  const [expanded, setExpanded] = useState(false)
  const lines = output ? output.split("\n") : []
  const isLong = lines.length > 3
  const displayLines = expanded ? lines : lines.slice(0, 3)

  return (
    <div className="mt-1">
      <pre className="text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded px-2 py-1.5 overflow-x-auto max-h-[300px] overflow-y-auto">
        <span className="text-foreground/60">$ {command}</span>
        {displayLines.length > 0 && "\n" + displayLines.join("\n")}
      </pre>
      <div className="flex items-center gap-2 mt-0.5">
        {isLong && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(!expanded)
            }}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? "Show less" : `Show all ${lines.length} lines`}
          </button>
        )}
        {exitCode != null && exitCode !== 0 && (
          <span className="text-[10px] text-red-500">exit code {exitCode}</span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Unified diff with color
// ---------------------------------------------------------------------------

function EditDetail({ filePath, unifiedDiff }: { filePath: string; unifiedDiff: string }) {
  return (
    <div className="mt-1">
      <span className="text-[10px] text-muted-foreground font-mono">{filePath}</span>
      <pre className="mt-0.5 text-[11px] leading-relaxed font-mono bg-muted/50 rounded px-2 py-1.5 overflow-x-auto max-h-[300px] overflow-y-auto">
        {unifiedDiff.split("\n").map((line, i) => (
          <div
            key={i}
            className={cn(
              line.startsWith("+") &&
                !line.startsWith("+++") &&
                "text-green-600 dark:text-green-400",
              line.startsWith("-") &&
                !line.startsWith("---") &&
                "text-red-600 dark:text-red-400",
              line.startsWith("@@") && "text-blue-600 dark:text-blue-400",
            )}
          >
            {line}
          </div>
        ))}
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail content renderer
// ---------------------------------------------------------------------------

function DetailContent({ toolCall }: { toolCall: ToolCallInfo }) {
  const d = toolCall.detail

  return (
    <div className="pl-[22px] pr-1 pb-1">
      {d.type === "shell" && (
        <ShellDetail command={d.command} output={d.output} exitCode={d.exitCode} />
      )}

      {d.type === "edit" && d.unifiedDiff && (
        <EditDetail filePath={d.filePath} unifiedDiff={d.unifiedDiff} />
      )}

      {d.type === "read" && d.content && (
        <pre className="mt-1 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded px-2 py-1.5 overflow-x-auto max-h-[200px] overflow-y-auto">
          {d.content.split("\n").slice(0, 10).join("\n")}
          {d.content.split("\n").length > 10 && "\n..."}
        </pre>
      )}

      {d.type === "write" && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Wrote to <span className="font-mono">{d.filePath}</span>
        </p>
      )}

      {d.type === "search" && (
        <p className="mt-1 text-[11px] text-muted-foreground font-mono">{d.query}</p>
      )}

      {d.type === "sub_agent" && d.log && (
        <pre className="mt-1 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded px-2 py-1.5 overflow-x-auto max-h-[200px] overflow-y-auto">
          {d.log}
        </pre>
      )}

      {d.type === "plain_text" && d.text && (
        <pre className="mt-1 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded px-2 py-1.5 overflow-x-auto max-h-[200px] overflow-y-auto">
          {d.text}
        </pre>
      )}

      {d.type === "unknown" && (d.input != null || d.output != null) && (
        <pre className="mt-1 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded px-2 py-1.5 overflow-x-auto max-h-[200px] overflow-y-auto">
          {String(JSON.stringify(d.output ?? d.input, null, 2))}
        </pre>
      )}

      {toolCall.error && (
        <p className="mt-1 text-[11px] text-red-500">{toolCall.error}</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function ToolCallItemComponent({ toolCall }: { toolCall: ToolCallInfo }) {
  const meta = getToolMeta(toolCall.toolName)
  const title = meta.getTitle(toolCall.detail)
  const expandable = hasDetailContent(toolCall) || !!toolCall.error

  // Default: collapsed if completed without error, expanded otherwise
  const [expanded, setExpanded] = useState(
    toolCall.status !== "completed" || !!toolCall.error,
  )

  const Icon = meta.icon

  return (
    <div className="group flex flex-col">
      {/* Header row */}
      <button
        onClick={() => {
          if (expandable) setExpanded(!expanded)
        }}
        className={cn(
          "flex items-center gap-1.5 py-0.5 rounded-md px-1 -mx-1 transition-colors duration-150 text-left w-full",
          expandable && "cursor-pointer hover:bg-foreground/5",
          !expandable && "cursor-default",
        )}
      >
        {/* Expand indicator */}
        {expandable && (
          <ChevronRight
            className={cn(
              "w-3 h-3 text-muted-foreground transition-transform duration-150 flex-shrink-0",
              expanded && "rotate-90",
            )}
          />
        )}
        {!expandable && <span className="w-3 flex-shrink-0" />}

        {/* Tool icon */}
        <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />

        {/* Label */}
        <span className="text-xs text-muted-foreground font-medium flex-shrink-0">
          {meta.label}
        </span>

        {/* Title */}
        {toolCall.status === "running" ? (
          <TextShimmer
            as="span"
            className="text-xs truncate flex-1 min-w-0"
            duration={1.2}
          >
            {title || "Running..."}
          </TextShimmer>
        ) : (
          <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
            {title}
          </span>
        )}

        {/* Status icon */}
        <span className="flex-shrink-0 ml-auto">
          <StatusIcon status={toolCall.status} />
        </span>
      </button>

      {/* Expandable detail content */}
      {expanded && expandable && <DetailContent toolCall={toolCall} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Memoized export with custom comparison
// ---------------------------------------------------------------------------

function contentLength(detail: ToolCallDetail): number {
  switch (detail.type) {
    case "shell":
      return (detail.output?.length ?? 0) + (detail.command?.length ?? 0)
    case "read":
      return detail.content?.length ?? 0
    case "edit":
      return detail.unifiedDiff?.length ?? 0
    case "write":
      return detail.filePath?.length ?? 0
    case "search":
      return detail.query?.length ?? 0
    case "sub_agent":
      return detail.log?.length ?? 0
    case "plain_text":
      return detail.text?.length ?? 0
    case "unknown":
      return 0
  }
}

export const ToolCallItem = memo(ToolCallItemComponent, (prev, next) => {
  const a = prev.toolCall
  const b = next.toolCall
  return (
    a.toolCallId === b.toolCallId &&
    a.status === b.status &&
    a.detail.type === b.detail.type &&
    contentLength(a.detail) === contentLength(b.detail) &&
    a.error === b.error
  )
})
