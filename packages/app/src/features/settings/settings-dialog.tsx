import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { useDaemonStore } from "@/stores/daemon-store"
import { cn } from "@/lib/cn"

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="connection" className="mt-2">
          <TabsList className="w-full">
            <TabsTrigger value="connection" className="flex-1">
              Connection
            </TabsTrigger>
            <TabsTrigger value="appearance" className="flex-1">
              Appearance
            </TabsTrigger>
            <TabsTrigger value="about" className="flex-1">
              About
            </TabsTrigger>
          </TabsList>

          <TabsContent value="connection" className="mt-4">
            <ConnectionSettings />
          </TabsContent>

          <TabsContent value="appearance" className="mt-4">
            <AppearanceSettings />
          </TabsContent>

          <TabsContent value="about" className="mt-4">
            <AboutSettings />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function ConnectionSettings() {
  const profiles = useDaemonStore((s) => s.profiles)
  const connections = useDaemonStore((s) => s.connections)
  const activeConnectionId = useDaemonStore((s) => s.activeConnectionId)
  const addConnection = useDaemonStore((s) => s.addConnection)
  const removeConnection = useDaemonStore((s) => s.removeConnection)

  const [newUrl, setNewUrl] = useState("")
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAdd = async () => {
    if (!newUrl.trim()) return
    setConnecting(true)
    setError(null)
    try {
      await addConnection(newUrl.trim())
      setNewUrl("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed")
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-2">Connected daemons</h3>
        {profiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">No connections</p>
        ) : (
          <div className="space-y-2">
            {profiles.map((p) => {
              const conn = connections.get(p.id)
              const isActive = p.id === activeConnectionId
              return (
                <div
                  key={p.id}
                  className={cn(
                    "flex items-center justify-between px-3 py-2 rounded-md border border-border",
                    isActive && "border-primary/50",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{p.label}</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {p.url}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-2">
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        conn?.status === "connected"
                          ? "bg-green-500"
                          : conn?.status === "connecting"
                            ? "bg-yellow-500 animate-pulse"
                            : "bg-muted-foreground",
                      )}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[10px] text-muted-foreground"
                      onClick={() => removeConnection(p.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Add daemon</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="ws://localhost:6767/ws"
            className={cn(
              "flex-1 px-2 py-1.5 text-xs rounded-md",
              "border border-border bg-background",
              "placeholder:text-muted-foreground/50",
              "focus:outline-none focus:ring-1 focus:ring-ring",
            )}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd()
            }}
          />
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={handleAdd}
            disabled={connecting || !newUrl.trim()}
          >
            {connecting ? "..." : "Connect"}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  )
}

function AppearanceSettings() {
  const [theme, setTheme] = useState(() => {
    if (typeof document === "undefined") return "dark"
    return document.documentElement.classList.contains("dark") ? "dark" : "light"
  })

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme)
    if (newTheme === "dark") {
      document.documentElement.classList.add("dark")
    } else {
      document.documentElement.classList.remove("dark")
    }
    try {
      localStorage.setItem("junction:theme", newTheme)
    } catch {}
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-2">Theme</h3>
        <div className="flex gap-2">
          <Button
            variant={theme === "dark" ? "default" : "outline"}
            size="sm"
            className="text-xs"
            onClick={() => handleThemeChange("dark")}
          >
            Dark
          </Button>
          <Button
            variant={theme === "light" ? "default" : "outline"}
            size="sm"
            className="text-xs"
            onClick={() => handleThemeChange("light")}
          >
            Light
          </Button>
        </div>
      </div>
    </div>
  )
}

function AboutSettings() {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Junction</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Distributed AI agent platform
        </p>
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <p>Version 0.1.0</p>
        <p>
          Keyboard shortcuts: {"\u2318"}\ toggle sidebar, {"\u2318"}N new chat,{" "}
          {"\u2318"}, settings
        </p>
      </div>
    </div>
  )
}
