import { useAtom, useAtomValue } from "jotai"
import {
  selectedAgentAtom,
  showNewChatFormAtom,
  pendingNewChatAtom,
} from "@/lib/atoms"
import { useDaemonStore } from "@/stores/daemon-store"
import { ConnectionPanel } from "@/features/daemons/connection-panel"
import { ChatView } from "@/features/chat/chat-view"
import { NewChatForm } from "@/features/chat/new-chat-form"

export function AgentsContent() {
  const profiles = useDaemonStore((s) => s.profiles)
  const connections = useDaemonStore((s) => s.connections)
  const activeConnectionId = useDaemonStore((s) => s.activeConnectionId)
  const activeClient = useDaemonStore((s) => s.getActiveClient())

  const selectedAgent = useAtomValue(selectedAgentAtom)
  const showNewChatForm = useAtomValue(showNewChatFormAtom)
  const [pendingNewChat, setPendingNewChat] = useAtom(pendingNewChatAtom)

  // Check if any daemon is connected
  const anyConnected = Array.from(connections.values()).some(
    (c) => c.status === "connected",
  )
  const anyConnecting = Array.from(connections.values()).some(
    (c) => c.status === "connecting",
  )

  // No saved profiles at all — show connection panel
  if (profiles.length === 0) {
    return <ConnectionPanel />
  }

  // Has profiles but all still reconnecting — show loading state
  if (!anyConnected && anyConnecting) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">Connecting to daemons...</p>
        </div>
      </div>
    )
  }

  // Has profiles but no connections at all
  if (!anyConnected) {
    return <ConnectionPanel />
  }

  // New chat form — uses the active daemon
  if (showNewChatForm && activeClient) {
    return <NewChatForm client={activeClient} />
  }

  // Pending new chat — find the correct daemon's client
  if (pendingNewChat && !selectedAgent) {
    const config = pendingNewChat
    const client =
      useDaemonStore.getState().getClient(config.daemonId) ?? activeClient
    if (client) {
      return (
        <ChatView
          key="pending-new-chat"
          client={client}
          daemonId={config.daemonId}
          provider={config.provider}
          cwd={config.cwd}
          initialPrompt={config.initialPrompt}
          onAgentCreated={() => {
            setPendingNewChat(null)
          }}
        />
      )
    }
  }

  // Active chat — use the daemon that owns this agent
  if (selectedAgent) {
    const client = useDaemonStore
      .getState()
      .getClient(selectedAgent.daemonId)
    if (client) {
      return (
        <ChatView
          key={`${selectedAgent.daemonId}-${selectedAgent.agentId}`}
          client={client}
          daemonId={selectedAgent.daemonId}
          agentId={selectedAgent.agentId}
        />
      )
    }
  }

  // Empty state
  return (
    <div className="flex-1 flex items-center justify-center h-full">
      <div className="text-center text-muted-foreground">
        <p className="text-lg font-medium">Junction</p>
        <p className="text-sm mt-1">
          Start a new chat or select an existing agent.
        </p>
      </div>
    </div>
  )
}
