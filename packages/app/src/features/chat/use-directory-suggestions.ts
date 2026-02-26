import { useState, useEffect, useRef } from "react"
import type { DaemonClient } from "@server/client/daemon-client"

export interface DirectoryEntry {
  path: string
  kind: "file" | "directory"
  isGitRepo?: boolean
}

export function useDirectorySuggestions(
  client: DaemonClient | null,
  options: {
    query: string
    onlyGitRepos?: boolean
    cwd?: string
  }
) {
  const [results, setResults] = useState<DirectoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const latestRequestRef = useRef(0)

  useEffect(() => {
    if (!client || !options.query.trim()) {
      setResults([])
      setLoading(false)
      return
    }

    const requestId = ++latestRequestRef.current
    setLoading(true)

    const timeout = setTimeout(async () => {
      try {
        const response = await client.getDirectorySuggestions({
          query: options.query,
          onlyGitRepos: options.onlyGitRepos,
          cwd: options.cwd,
        })

        // Only update if this is still the latest request
        if (requestId === latestRequestRef.current) {
          const entries: DirectoryEntry[] =
            response.entries && response.entries.length > 0
              ? response.entries
              : response.directories.map((d) => ({
                  path: d,
                  kind: "directory" as const,
                }))
          setResults(entries)
        }
      } catch {
        if (requestId === latestRequestRef.current) {
          setResults([])
        }
      } finally {
        if (requestId === latestRequestRef.current) {
          setLoading(false)
        }
      }
    }, 200)

    return () => clearTimeout(timeout)
  }, [client, options.query, options.onlyGitRepos, options.cwd])

  return { results, loading }
}
