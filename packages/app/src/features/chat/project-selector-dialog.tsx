import { useState } from "react"
import type { DaemonClient } from "@server/client/daemon-client"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { useDirectorySuggestions } from "./use-directory-suggestions"
import { DirectoryBrowserPopover } from "./directory-browser-popover"
import { Folder, GitBranch, Loader2 } from "lucide-react"
import { cn } from "@/lib/cn"

interface ProjectSelectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  client: DaemonClient | null
  onSelect: (cwd: string) => void
}

export function ProjectSelectorDialog({
  open,
  onOpenChange,
  client,
  onSelect,
}: ProjectSelectorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] p-0 gap-0 overflow-hidden">
        <Tabs defaultValue="open" className="w-full">
          <DialogHeader className="px-6 pt-5 pb-0">
            <DialogTitle className="text-base mb-3">Select project</DialogTitle>
            <TabsList className="w-full">
              <TabsTrigger value="open" className="flex-1 text-xs">
                Open project
              </TabsTrigger>
              <TabsTrigger value="clone" className="flex-1 text-xs">
                Clone from URL
              </TabsTrigger>
              <TabsTrigger value="quickstart" className="flex-1 text-xs">
                Quick start
              </TabsTrigger>
            </TabsList>
          </DialogHeader>

          <TabsContent value="open" className="mt-0">
            <OpenProjectTab
              client={client}
              onSelect={(path) => {
                onSelect(path)
                onOpenChange(false)
              }}
            />
          </TabsContent>

          <TabsContent value="clone" className="mt-0">
            <CloneFromUrlTab
              client={client}
              onSelect={(path) => {
                onSelect(path)
                onOpenChange(false)
              }}
            />
          </TabsContent>

          <TabsContent value="quickstart" className="mt-0">
            <QuickStartTab
              client={client}
              onSelect={(path) => {
                onSelect(path)
                onOpenChange(false)
              }}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// ─── Open Project Tab ──────────────────────────────────────────────────────────

function OpenProjectTab({
  client,
  onSelect,
}: {
  client: DaemonClient | null
  onSelect: (path: string) => void
}) {
  const [query, setQuery] = useState("")

  const { results, loading } = useDirectorySuggestions(client, {
    query: query || "~/",
    onlyGitRepos: true,
  })

  return (
    <div className="px-2 pb-2">
      <Command>
        <CommandInput
          placeholder="Search for a repository..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-[240px]">
          {!loading && results.length === 0 && query && (
            <CommandEmpty>No repositories found.</CommandEmpty>
          )}
          {!loading && results.length === 0 && !query && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              Type to search for Git repositories
            </div>
          )}
          {loading && results.length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Searching...
            </div>
          )}
          {results.map((entry) => (
            <CommandItem
              key={entry.path}
              value={entry.path}
              onSelect={() => onSelect(entry.path)}
              className="flex items-center gap-2"
            >
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-medium truncate">
                  {getBasename(entry.path)}
                </span>
                <span className="text-[10px] text-muted-foreground font-mono truncate">
                  {shortenPath(entry.path)}
                </span>
              </div>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  )
}

// ─── Clone from URL Tab ────────────────────────────────────────────────────────

function CloneFromUrlTab({
  client,
  onSelect,
}: {
  client: DaemonClient | null
  onSelect: (path: string) => void
}) {
  const [url, setUrl] = useState("")
  const [targetDir, setTargetDir] = useState("~/")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const repoName = extractRepoName(url)
  const fullTarget = targetDir.endsWith("/")
    ? targetDir + repoName
    : targetDir + "/" + repoName

  async function handleClone(e: React.FormEvent) {
    e.preventDefault()
    if (!client || !url.trim()) return

    setLoading(true)
    setError(null)

    try {
      const result = await client.gitClone({
        url: url.trim(),
        targetDirectory: fullTarget,
      })

      if (result.error) {
        setError(result.error)
      } else if (result.clonedPath) {
        onSelect(result.clonedPath)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clone failed")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleClone} className="px-6 py-4 space-y-4">
      <div className="space-y-2">
        <label className="text-xs font-medium" htmlFor="git-url">
          Git URL
        </label>
        <input
          id="git-url"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/user/repo.git"
          className={cn(
            "w-full px-3 py-2 text-xs font-mono border border-border rounded-md bg-background",
            "focus:outline-none focus:ring-2 focus:ring-ring",
            "placeholder:text-muted-foreground/50",
          )}
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium" htmlFor="clone-location">
          Clone location
        </label>
        <div className="flex gap-2">
          <input
            id="clone-location"
            type="text"
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
            placeholder="~/"
            className={cn(
              "flex-1 px-3 py-2 text-xs font-mono border border-border rounded-md bg-background",
              "focus:outline-none focus:ring-2 focus:ring-ring",
              "placeholder:text-muted-foreground/50",
            )}
          />
          <DirectoryBrowserPopover
            client={client}
            value={targetDir}
            onChange={setTargetDir}
          />
        </div>
        {repoName && (
          <p className="text-[10px] text-muted-foreground font-mono">
            Will clone to: {fullTarget}
          </p>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="submit" disabled={loading || !url.trim()}>
          {loading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
              Cloning...
            </>
          ) : (
            "Clone repository"
          )}
        </Button>
      </div>
    </form>
  )
}

// ─── Quick Start Tab ───────────────────────────────────────────────────────────

function QuickStartTab({
  client,
  onSelect,
}: {
  client: DaemonClient | null
  onSelect: (path: string) => void
}) {
  const [name, setName] = useState("")
  const [location, setLocation] = useState("~/")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!client || !name.trim()) return

    setLoading(true)
    setError(null)

    try {
      const result = await client.gitInit({
        targetDirectory: location,
        projectName: name.trim(),
      })

      if (result.error) {
        setError(result.error)
      } else if (result.createdPath) {
        onSelect(result.createdPath)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create project")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleCreate} className="px-6 py-4 space-y-4">
      <p className="text-xs text-muted-foreground">
        Create a new folder with Git initialized.
      </p>

      <div className="space-y-2">
        <label className="text-xs font-medium" htmlFor="project-name">
          Name
        </label>
        <input
          id="project-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          className={cn(
            "w-full px-3 py-2 text-xs font-mono border border-border rounded-md bg-background",
            "focus:outline-none focus:ring-2 focus:ring-ring",
            "placeholder:text-muted-foreground/50",
          )}
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium" htmlFor="project-location">
          Location
        </label>
        <div className="flex gap-2">
          <input
            id="project-location"
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="~/"
            className={cn(
              "flex-1 px-3 py-2 text-xs font-mono border border-border rounded-md bg-background",
              "focus:outline-none focus:ring-2 focus:ring-ring",
              "placeholder:text-muted-foreground/50",
            )}
          />
          <DirectoryBrowserPopover
            client={client}
            value={location}
            onChange={setLocation}
          />
        </div>
        {name && (
          <p className="text-[10px] text-muted-foreground font-mono">
            Will create: {location.endsWith("/") ? location : location + "/"}{name}
          </p>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="submit" disabled={loading || !name.trim()}>
          {loading ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
              Creating...
            </>
          ) : (
            "Create"
          )}
        </Button>
      </div>
    </form>
  )
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getBasename(p: string): string {
  const segments = p.replace(/\/+$/, "").split("/")
  return segments[segments.length - 1] || p
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~")
}

function extractRepoName(url: string): string {
  if (!url) return ""
  // Handle https://github.com/user/repo.git and git@github.com:user/repo.git
  const match = url.match(/\/([^/]+?)(?:\.git)?$/) || url.match(/:([^/]+?)(?:\.git)?$/)
  return match?.[1] || ""
}
