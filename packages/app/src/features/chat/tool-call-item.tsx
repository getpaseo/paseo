import { useState } from "react"
import type { ToolCallInfo } from "./use-agent-chat"
import { cn } from "@/lib/cn"

const TOOL_META: Record<
  string,
  { label: string; icon: string; getTitle?: (detail: unknown) => string }
> = {
  Bash: {
    label: "Terminal",
    icon: "$",
    getTitle: (d) => {
      const detail = d as { command?: string }
      return detail.command
        ? detail.command.length > 80
          ? detail.command.slice(0, 80) + "..."
          : detail.command
        : "Running command..."
    },
  },
  Read: {
    label: "Read",
    icon: "R",
    getTitle: (d) => (d as { filePath?: string }).filePath ?? "Reading file...",
  },
  Edit: {
    label: "Edit",
    icon: "E",
    getTitle: (d) => (d as { filePath?: string }).filePath ?? "Editing file...",
  },
  Write: {
    label: "Write",
    icon: "W",
    getTitle: (d) =>
      (d as { filePath?: string }).filePath ?? "Writing file...",
  },
  Grep: {
    label: "Search",
    icon: "S",
    getTitle: (d) => (d as { query?: string }).query ?? "Searching...",
  },
  Glob: {
    label: "Search",
    icon: "G",
    getTitle: (d) => (d as { query?: string }).query ?? "Searching files...",
  },
  Task: {
    label: "Sub-agent",
    icon: "T",
    getTitle: (d) =>
      (d as { description?: string }).description ?? "Running sub-agent...",
  },
  WebSearch: {
    label: "Web Search",
    icon: "W",
    getTitle: (d) => (d as { query?: string }).query ?? "Searching web...",
  },
  WebFetch: {
    label: "Web Fetch",
    icon: "F",
    getTitle: (d) => (d as { query?: string }).query ?? "Fetching URL...",
  },
}

function getToolMeta(toolName: string) {
  return TOOL_META[toolName] ?? { label: toolName, icon: "?" }
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-block w-1.5 h-1.5 rounded-full flex-shrink-0",
        status === "running" && "bg-yellow-500 animate-pulse",
        status === "completed" && "bg-green-500",
        status === "failed" && "bg-red-500",
        status === "canceled" && "bg-muted-foreground",
      )}
    />
  )
}

function ShellOutput({ output, exitCode }: { output: string; exitCode?: number | null }) {
  const [expanded, setExpanded] = useState(false)
  const lines = output.split("\n")
  const isLong = lines.length > 10
  const displayLines = expanded ? lines : lines.slice(0, 10)

  return (
    <div className="mt-1.5">
      <pre className="text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded p-2 overflow-x-auto max-h-[300px] overflow-y-auto">
        {displayLines.join("\n")}
      </pre>
      <div className="flex items-center gap-2 mt-1">
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            {expanded ? "Show less" : `Show all ${lines.length} lines`}
          </button>
        )}
        {exitCode != null && exitCode !== 0 && (
          <span className="text-[10px] text-red-500">
            exit code {exitCode}
          </span>
        )}
      </div>
    </div>
  )
}

function EditDiff({ unifiedDiff }: { unifiedDiff: string }) {
  return (
    <pre className="mt-1.5 text-[11px] leading-relaxed font-mono bg-muted/50 rounded p-2 overflow-x-auto max-h-[300px] overflow-y-auto">
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
            line.startsWith("@@") &&
              "text-blue-600 dark:text-blue-400",
          )}
        >
          {line}
        </div>
      ))}
    </pre>
  )
}

export function ToolCallItem({ toolCall }: { toolCall: ToolCallInfo }) {
  const meta = getToolMeta(toolCall.toolName)
  const title = meta.getTitle?.(toolCall.detail) ?? toolCall.toolName
  const [collapsed, setCollapsed] = useState(
    toolCall.status === "completed" && !toolCall.error,
  )

  return (
    <div className="border border-border rounded-md overflow-hidden my-1.5">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent/50 transition-colors"
      >
        <StatusDot status={toolCall.status} />
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide min-w-[50px]">
          {meta.label}
        </span>
        <span className="text-xs truncate flex-1 font-mono">{title}</span>
        <span className="text-[10px] text-muted-foreground">
          {collapsed ? "+" : "-"}
        </span>
      </button>

      {!collapsed && (
        <div className="px-2.5 pb-2 border-t border-border">
          {toolCall.detail.type === "shell" && toolCall.detail.output && (
            <ShellOutput
              output={toolCall.detail.output}
              exitCode={toolCall.detail.exitCode}
            />
          )}

          {toolCall.detail.type === "edit" && toolCall.detail.unifiedDiff && (
            <EditDiff unifiedDiff={toolCall.detail.unifiedDiff} />
          )}

          {toolCall.detail.type === "read" && toolCall.detail.content && (
            <pre className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded p-2 overflow-x-auto max-h-[200px] overflow-y-auto">
              {toolCall.detail.content}
            </pre>
          )}

          {toolCall.detail.type === "write" && (
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Wrote to {toolCall.detail.filePath}
            </p>
          )}

          {toolCall.detail.type === "search" && (
            <p className="text-[11px] text-muted-foreground mt-1.5 font-mono">
              {toolCall.detail.query}
            </p>
          )}

          {toolCall.detail.type === "sub_agent" && toolCall.detail.log && (
            <pre className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap font-mono bg-muted/50 rounded p-2 overflow-x-auto max-h-[200px] overflow-y-auto">
              {toolCall.detail.log}
            </pre>
          )}

          {toolCall.error && (
            <p className="text-[11px] text-red-500 mt-1.5">{toolCall.error}</p>
          )}
        </div>
      )}
    </div>
  )
}
