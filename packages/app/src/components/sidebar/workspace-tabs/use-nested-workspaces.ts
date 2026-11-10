import { useMemo } from "react";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { selectNestedSubagentWorkspaceKeys } from "./nested-workspaces";

type SessionState = ReturnType<typeof useSessionStore.getState>;
type AgentsByServerId = ReadonlyMap<string, ReadonlyMap<string, Agent>>;

const NO_KEYS: ReadonlySet<string> = new Set();
const NO_AGENTS: AgentsByServerId = new Map();

/**
 * Reuses the previous map until a host's agent map changes, so stream ticks that leave the
 * agents alone cost a reference check per host.
 */
function createAgentsByServerIdSelector(): (state: SessionState) => AgentsByServerId {
  let last: AgentsByServerId = NO_AGENTS;
  return (state) => {
    const entries = Object.entries(state.sessions);
    const unchanged =
      entries.length === last.size &&
      entries.every(([serverId, session]) => last.get(serverId) === session.agents);
    if (unchanged) return last;
    last = new Map(entries.map(([serverId, session]) => [serverId, session.agents]));
    return last;
  };
}

/**
 * Workspace keys the sidebar leaves off its own rows because they only hold subagents listed
 * under a parent's tab, while the Settings > Sidebar display toggle is on.
 */
export function useNestedSubagentWorkspaceKeys(): ReadonlySet<string> {
  const enabled = useSidebarViewStore((state) => state.nestSubagentWorkspaces);
  const selectAgents = useMemo(createAgentsByServerIdSelector, []);
  const agentsByServerId = useSessionStore((state) => (enabled ? selectAgents(state) : NO_AGENTS));
  const layoutByWorkspace = useWorkspaceLayoutStore((state) =>
    enabled ? state.layoutByWorkspace : null,
  );
  const keys = useMemo(() => {
    if (!layoutByWorkspace || agentsByServerId.size === 0) return [];
    return selectNestedSubagentWorkspaceKeys({
      agentsByServerId,
      hasAgentTab: (serverId, workspaceId, agentId) => {
        const layoutKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
        const layout = layoutKey ? layoutByWorkspace[layoutKey] : undefined;
        if (!layout) return false;
        return collectAllTabs(layout.root).some(
          (tab) => tab.target.kind === "agent" && tab.target.agentId === agentId,
        );
      },
    });
  }, [agentsByServerId, layoutByWorkspace]);
  const joined = keys.join("\n");
  return useMemo(() => (joined ? new Set(joined.split("\n")) : NO_KEYS), [joined]);
}
