import { useState } from "react"
import { useDaemonStore } from "@/stores/daemon-store"

export function ConnectionPanel() {
  const [url, setUrl] = useState("ws://localhost:6767/ws")
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const addConnection = useDaemonStore((s) => s.addConnection)

  async function handleConnect() {
    setConnecting(true)
    setError(null)
    try {
      await addConnection(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed")
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-full max-w-md p-8 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">Junction</h1>
          <p className="text-sm text-muted-foreground">
            Connect to a daemon to get started
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="daemon-url">
              Daemon URL
            </label>
            <input
              id="daemon-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="ws://localhost:6767/ws"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConnect()
              }}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <button
            onClick={handleConnect}
            disabled={connecting || !url}
            className="w-full px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {connecting ? "Connecting..." : "Connect"}
          </button>
        </div>
      </div>
    </div>
  )
}
