import { useAtom } from "jotai"
import { useCallback, useEffect, useState } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { PanelLeftOpen, Plus } from "lucide-react"
import { useDaemonStore } from "@/stores/daemon-store"
import {
  sidebarOpenAtom,
  sidebarWidthAtom,
  showNewChatFormAtom,
  selectedAgentAtom,
} from "@/lib/atoms"
import { ResizableSidebar } from "@/components/ui/resizable-sidebar"
import { AgentsSidebar } from "@/features/sidebar/agents-sidebar"
import { AgentsContent } from "@/features/chat/agents-content"
import { SettingsDialog } from "@/features/settings/settings-dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom)
  const [, setShowNewChatForm] = useAtom(showNewChatFormAtom)
  const [, setSelectedAgent] = useAtom(selectedAgentAtom)
  const profiles = useDaemonStore((s) => s.profiles)
  const connections = useDaemonStore((s) => s.connections)
  const reconnectAll = useDaemonStore((s) => s.reconnectAll)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Auto-reconnect all saved profiles on mount
  useEffect(() => {
    if (profiles.length > 0 && connections.size === 0) {
      reconnectAll()
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
    setSelectedAgent(null)
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
          {/* Collapsed sidebar rail — visible when sidebar is closed */}
          {!sidebarOpen && (
            <div className="flex flex-col items-center py-2 px-1 gap-1 border-r border-border/50 bg-background flex-shrink-0"
              style={{ width: 40 }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={4}>
                  <span>Open sidebar</span>
                  <span className="ml-2 text-muted-foreground text-[10px]">{"\u2318\\"}</span>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setSelectedAgent(null)
                      setShowNewChatForm(true)
                    }}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={4}>
                  <span>New chat</span>
                  <span className="ml-2 text-muted-foreground text-[10px]">{"\u2318N"}</span>
                </TooltipContent>
              </Tooltip>
            </div>
          )}

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
