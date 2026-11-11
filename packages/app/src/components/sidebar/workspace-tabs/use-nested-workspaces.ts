import { useMemo } from "react";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { collectAllTabs } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { selectNestedSubagentWorkspaces, type NestedSubagentWorkspaces } from "./nested-workspaces";

type SessionState = ReturnType<typeof useSessionStore.getState>;
type AgentsByServerId = ReadonlyMap<string, ReadonlyMap<string, Agent>>;

const NO_KEYS: ReadonlySet<string> = new Set();
const NO_PARENTS: NestedSubagentWorkspaces["parentsByKey"] = new Map();
const NO_AGENTS: AgentsByServerId = new Map();
const NO_NESTED: NestedSubagentWorkspaceIndex = { keys: NO_KEYS, parentsByKey: NO_PARENTS };

export interface NestedSubagentWorkspaceIndex {
  keys: ReadonlySet<string>;
  /** Nested workspace key → the parent workspace keys it is listed under. */
  parentsByKey: ReadonlyMap<string, readonly string[]>;
}

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
 * Workspaces the sidebar lists under a parent's tab instead of on their own row, and which
 * parent rows those workspaces belong to. The Settings > Sidebar display toggle gates it.
 * The signature keeps the set and the parent map stable until the nesting actually changes.
 */
export function useNestedSubagentWorkspaces(): NestedSubagentWorkspaceIndex {
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
  const signature = useMemo(() => {
    if (agentTabWorkspaceKeys.size === 0 || agentsByServerId.size === 0) return "";
    const nested = selectNestedSubagentWorkspaces({ agentsByServerId, agentTabWorkspaceKeys });
    return nested.keys
      .map((key) => `${key}\0${(nested.parentsByKey.get(key) ?? []).join("\0")}`)
      .join("\n");
  }, [agentsByServerId, agentTabWorkspaceKeys]);
  return useMemo(() => nestedIndexFromSignature(signature), [signature]);
}

function nestedIndexFromSignature(signature: string): NestedSubagentWorkspaceIndex {
  if (!signature) return NO_NESTED;
  const parentsByKey = new Map<string, readonly string[]>();
  for (const entry of signature.split("\n")) {
    const [key, ...parents] = entry.split("\0");
    if (!key) continue;
    parentsByKey.set(key, parents);
  }
  return { keys: new Set(parentsByKey.keys()), parentsByKey };
}
