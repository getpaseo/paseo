import { useState } from "react"
import type { DaemonClient } from "@server/client/daemon-client"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from "@/components/ui/command"
import { useDirectorySuggestions } from "./use-directory-suggestions"
import { Folder, ChevronRight } from "lucide-react"
import { cn } from "@/lib/cn"

interface DirectoryBrowserPopoverProps {
  client: DaemonClient | null
  value: string
  onChange: (path: string) => void
  placeholder?: string
  className?: string
}

export function DirectoryBrowserPopover({
  client,
  value,
  onChange,
  placeholder = "Browse...",
  className,
}: DirectoryBrowserPopoverProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value || "~/")

  const { results, loading } = useDirectorySuggestions(client, {
    query: query || "~/",
  })

  const handleSelect = (path: string) => {
    onChange(path)
    setOpen(false)
  }

  const handleDrillDown = (path: string) => {
    setQuery(path + "/")
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("text-xs font-normal", className)}
        >
          {placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Search directories..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {!loading && results.length === 0 && (
              <CommandEmpty>No directories found.</CommandEmpty>
            )}
            {loading && results.length === 0 && (
              <div className="py-4 text-center text-xs text-muted-foreground">
                Searching...
              </div>
            )}
            {results.map((entry) => (
              <CommandItem
                key={entry.path}
                value={entry.path}
                onSelect={() => handleSelect(entry.path)}
                className="flex items-center gap-2 text-xs"
              >
                <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="truncate font-mono flex-1">
                  {entry.path.startsWith("/")
                    ? entry.path.replace(
                        new RegExp(`^${escapeRegex(getHomePath())}`),
                        "~"
                      )
                    : entry.path}
                </span>
                {entry.kind === "directory" && (
                  <button
                    type="button"
                    className="shrink-0 p-0.5 rounded hover:bg-muted"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDrillDown(entry.path)
                    }}
                  >
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  </button>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function getHomePath(): string {
  // In a web context, we approximate the home path
  // The server handles tilde expansion
  return "/Users/" + (window.location.hostname || "user")
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
