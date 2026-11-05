import { useRetainedPanelActive } from "@/components/retained-panel";
import { useSessionStore } from "@/stores/session-store";

// The view retains its last visible transcript. Selecting a stable value here
// also prevents incoming chunks from scheduling React work in a hidden panel.
// Revealing the panel reads the current tail directly from the model.
export function useAgentStreamTail(serverId: string, agentId: string | undefined) {
  const active = useRetainedPanelActive();
  return useSessionStore((state) =>
    active && agentId ? state.sessions[serverId]?.agentStreamTail.get(agentId) : undefined,
  );
}
