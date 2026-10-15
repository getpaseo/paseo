import { useMemo } from "react";
import { getHostRuntimeStore, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { nextAttentionAgent } from "@/utils/next-attention-agent";

export function getNextAttentionAgent(serverId: string, agentId: string) {
  const sessions = useSessionStore.getState().sessions;
  const hostRuntime = getHostRuntimeStore();
  return nextAttentionAgent({
    sessions,
    connectedServerIds: new Set(
      Object.keys(sessions).filter(
        (id) => hostRuntime.getSnapshot(id)?.connectionStatus === "online",
      ),
    ),
    getWorkspaceTabs: useWorkspaceLayoutStore.getState().getWorkspaceTabs,
    current: { serverId, agentId },
  });
}

export function useNextAttentionAgent(serverId: string, agentId: string) {
  const sessions = useSessionStore((state) => state.sessions);
  const layoutByWorkspace = useWorkspaceLayoutStore((state) => state.layoutByWorkspace);
  const serverIds = useMemo(() => Object.keys(sessions), [sessions]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  return useMemo(() => {
    void layoutByWorkspace;
    return nextAttentionAgent({
      sessions,
      connectedServerIds: new Set(serverIds.filter((id) => statuses.get(id) === "online")),
      getWorkspaceTabs: useWorkspaceLayoutStore.getState().getWorkspaceTabs,
      current: { serverId, agentId },
    });
  }, [agentId, layoutByWorkspace, serverId, serverIds, sessions, statuses]);
}
