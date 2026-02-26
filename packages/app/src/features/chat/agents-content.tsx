import { useAtom, useAtomValue } from "jotai"
import {
  selectedAgentIdAtom,
  showNewChatFormAtom,
  pendingNewChatAtom,
} from "@/lib/atoms"
import { useDaemonStore } from "@/stores/daemon-store"
import { ConnectionPanel } from "@/features/daemons/connection-panel"
import { ChatView } from "@/features/chat/chat-view"
import { NewChatForm } from "@/features/chat/new-chat-form"

export function AgentsContent() {
  const activeConnectionId = useDaemonStore((s) => s.activeConnectionId)
  const connections = useDaemonStore((s) => s.connections)
  const client = useDaemonStore((s) => s.getActiveClient())

  const selectedAgentId = useAtomValue(selectedAgentIdAtom)
  const showNewChatForm = useAtomValue(showNewChatFormAtom)
  const [pendingNewChat, setPendingNewChat] = useAtom(pendingNewChatAtom)

  const activeConn = activeConnectionId
    ? connections.get(activeConnectionId)
    : null
  const isConnected = activeConn?.status === "connected"

  // No connection: show connection panel
  if (!activeConnectionId || !isConnected || !client) {
    return <ConnectionPanel />
  }

  // New chat form
  if (showNewChatForm) {
    return <NewChatForm client={client} />
  }

  // Pending new chat (submitted from NewChatForm, no agent yet)
  if (pendingNewChat && !selectedAgentId) {
    const config = pendingNewChat
    return (
      <ChatView
        key="pending-new-chat"
        client={client}
        provider={config.provider}
        cwd={config.cwd}
        initialPrompt={config.initialPrompt}
        onAgentCreated={(agentId) => {
          setPendingNewChat(null)
        }}
      />
    )
  }

  // Active chat
  if (selectedAgentId) {
    return (
      <ChatView
        key={selectedAgentId}
        client={client}
        agentId={selectedAgentId}
      />
    )
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
