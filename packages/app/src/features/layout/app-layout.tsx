import { useAtom } from "jotai"
import { useCallback, useEffect, useState } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useDaemonStore } from "@/stores/daemon-store"
import {
  sidebarOpenAtom,
  sidebarWidthAtom,
  showNewChatFormAtom,
  selectedAgentIdAtom,
} from "@/lib/atoms"
import { ResizableSidebar } from "@/components/ui/resizable-sidebar"
import { AgentsSidebar } from "@/features/sidebar/agents-sidebar"
import { AgentsContent } from "@/features/chat/agents-content"
import { SettingsDialog } from "@/features/settings/settings-dialog"
import { TooltipProvider } from "@/components/ui/tooltip"

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom)
  const [, setShowNewChatForm] = useAtom(showNewChatFormAtom)
  const [, setSelectedAgentId] = useAtom(selectedAgentIdAtom)
  const profiles = useDaemonStore((s) => s.profiles)
  const connections = useDaemonStore((s) => s.connections)
  const addConnection = useDaemonStore((s) => s.addConnection)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Auto-reconnect
  useEffect(() => {
    if (profiles.length > 0 && connections.size === 0) {
      addConnection(profiles[0].url, profiles[0].label).catch(() => {})
    }
  }, [])

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false)
  }, [setSidebarOpen])

  // Keyboard shortcuts
  useHotkeys("mod+\\", (e) => {
    e.preventDefault()
    setSidebarOpen((prev) => !prev)
  })

  useHotkeys("mod+n", (e) => {
    e.preventDefault()
    setSelectedAgentId(null)
    setShowNewChatForm(true)
  })

  useHotkeys("mod+,", (e) => {
    e.preventDefault()
    setSettingsOpen(true)
  })

  useHotkeys("escape", () => {
    setSettingsOpen(false)
  })

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col w-full h-full relative overflow-hidden bg-background select-none">
        <div className="flex flex-1 overflow-hidden">
          <ResizableSidebar
            isOpen={sidebarOpen}
            onClose={handleCloseSidebar}
            widthAtom={sidebarWidthAtom}
            minWidth={160}
            maxWidth={300}
            side="left"
            closeHotkey={"\u2318\\"}
            animationDuration={0}
            initialWidth={0}
            exitWidth={0}
            showResizeTooltip
            className="overflow-hidden bg-background border-r"
            style={{ borderRightWidth: "0.5px" }}
          >
            <AgentsSidebar />
          </ResizableSidebar>

          <div className="flex-1 overflow-hidden flex flex-col min-w-0">
            <AgentsContent />
          </div>
        </div>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </TooltipProvider>
  )
}
