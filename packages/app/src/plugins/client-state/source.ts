import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { createPluginAgentSnapshot, createPluginWorkspaceSnapshot } from "./snapshots";

export function createPluginClientStateSource(serverId: string): PluginClientStateSource {
  return {
    subscribe: useSessionStore.subscribe,
    getWorkspace(workspaceId) {
      const workspace = selectWorkspace(useSessionStore.getState(), serverId, workspaceId);
      return workspace ? createPluginWorkspaceSnapshot(workspace) : null;
    },
    getAgent(agentId) {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
      const workspaceId = normalizeWorkspaceOpaqueId(agent?.workspaceId);
      return agent && workspaceId ? createPluginAgentSnapshot(agent, workspaceId) : null;
    },
  };
}
