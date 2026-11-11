import { useMemo } from "react";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
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
  const agentTabWorkspaceKeys = useMemo(() => {
    const keys = new Map<string, string>();
    if (!layoutByWorkspace) return keys;
    for (const [layoutKey, layout] of Object.entries(layoutByWorkspace)) {
      // Layout keys are `${serverId}:${workspaceId}`, the same key a sidebar workspace row uses.
      const serverId = layoutKey.slice(0, layoutKey.indexOf(":"));
      if (!layout || !serverId) continue;
      for (const tab of collectAllTabs(layout.root)) {
        if (tab.target.kind === "agent") keys.set(`${serverId}:${tab.target.agentId}`, layoutKey);
      }
    }
    return keys;
  }, [layoutByWorkspace]);
  const keys = useMemo(() => {
    if (agentTabWorkspaceKeys.size === 0 || agentsByServerId.size === 0) return [];
    return selectNestedSubagentWorkspaceKeys({ agentsByServerId, agentTabWorkspaceKeys });
  }, [agentsByServerId, agentTabWorkspaceKeys]);
  const joined = keys.join("\n");
  return useMemo(() => (joined ? new Set(joined.split("\n")) : NO_KEYS), [joined]);
}
