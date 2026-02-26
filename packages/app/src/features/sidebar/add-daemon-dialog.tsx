import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"

interface AddDaemonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (url: string, label: string) => Promise<void>
}

export function AddDaemonDialog({
  open,
  onOpenChange,
  onAdd,
}: AddDaemonDialogProps) {
  const [url, setUrl] = useState("ws://localhost:6767/ws")
  const [label, setLabel] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) return
    setLoading(true)
    setError(null)
    try {
      const effectiveLabel =
        label.trim() ||
        new URL(
          url.replace("ws://", "http://").replace("wss://", "https://"),
        ).hostname
      await onAdd(url.trim(), effectiveLabel)
      setUrl("ws://localhost:6767/ws")
      setLabel("")
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Add Daemon</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="daemon-label">
              Label
            </label>
            <input
              id="daemon-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className={cn(
                "w-full px-3 py-2 text-sm border border-border rounded-md bg-background",
                "focus:outline-none focus:ring-2 focus:ring-ring",
                "placeholder:text-muted-foreground/50",
              )}
              placeholder="e.g. local-dev"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="daemon-url">
              WebSocket URL
            </label>
            <input
              id="daemon-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={cn(
                "w-full px-3 py-2 text-sm border border-border rounded-md bg-background",
                "focus:outline-none focus:ring-2 focus:ring-ring",
                "placeholder:text-muted-foreground/50",
              )}
              placeholder="ws://localhost:6767/ws"
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !url.trim()}>
              {loading ? "Connecting..." : "Connect"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
