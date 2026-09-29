import { useEffect } from "react";
import { useSessionStore } from "@/stores/session-store";
import {
  collectAllTabs,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";

/**
 * A session tab moves to the front of its pane when its turn finishes, the way the sidebar
 * lists sessions newest activity first, so the one that just answered is the first tab.
 */
export function useFinishedAgentTabsToFront(input: {
  serverId: string;
  workspaceKey: string | null;
}): void {
  const { serverId, workspaceKey } = input;
  useEffect(() => {
    if (!workspaceKey) return undefined;
    const previousStatus = new Map<string, string>();
    const snapshot = useSessionStore.getState().sessions[serverId]?.agents;
    for (const agent of snapshot?.values() ?? []) previousStatus.set(agent.id, agent.status);
    return useSessionStore.subscribe((state) => {
      const agents = state.sessions[serverId]?.agents;
      if (!agents) return;
      for (const agent of agents.values()) {
        const before = previousStatus.get(agent.id);
        previousStatus.set(agent.id, agent.status);
        if (before === "running" && agent.status === "idle")
          moveAgentTabToFront(workspaceKey, agent.id);
      }
    });
  }, [serverId, workspaceKey]);
}

function moveAgentTabToFront(workspaceKey: string, agentId: string): void {
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[workspaceKey];
  if (!layout) return;
  const tab = collectAllTabs(layout.root).find(
    (candidate) => candidate.target.kind === "agent" && candidate.target.agentId === agentId,
  );
  if (!tab) return;
  const pane = findPaneContainingTab(layout.root, tab.tabId);
  if (!pane || pane.tabIds[0] === tab.tabId) return;
  store.reorderTabsInPane(workspaceKey, pane.id, [
    tab.tabId,
    ...pane.tabIds.filter((tabId) => tabId !== tab.tabId),
  ]);
}
