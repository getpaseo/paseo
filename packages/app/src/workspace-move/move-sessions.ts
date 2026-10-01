import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import {
  collectAllTabs,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useSessionStore } from "@/stores/session-store";

export interface MoveWorkspaceSessionsResult {
  moved: number;
}

/**
 * Moves every open session of one workspace into another, like dragging it across, and
 * shows them there. The source is never archived here: the app's session list can be
 * incomplete, and archiving a workspace archives whatever it still holds.
 */
export async function moveWorkspaceSessions(input: {
  serverId: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
}): Promise<MoveWorkspaceSessionsResult> {
  const { serverId, sourceWorkspaceId, targetWorkspaceId } = input;
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error("The host is not connected");
  const session = useSessionStore.getState().sessions[serverId];
  const agentIds = [...(session?.agents.values() ?? [])]
    .filter((agent) => agent.workspaceId === sourceWorkspaceId && !agent.archivedAt)
    .map((agent) => agent.id);
  for (const agentId of agentIds.toReversed()) {
    await moveSessionToWorkspace({ serverId, agentId, targetWorkspaceId, navigate: false });
  }
  const [first] = agentIds;
  navigateToWorkspace({
    serverId,
    workspaceId: targetWorkspaceId,
    ...(first ? { target: { kind: "agent", agentId: first } } : {}),
  });
  return { moved: agentIds.length };
}

/** One session, dragged from its tab onto another workspace, opened where it landed. */
export async function moveSessionToWorkspace(input: {
  serverId: string;
  agentId: string;
  targetWorkspaceId: string;
  navigate?: boolean;
}): Promise<void> {
  const client = getHostRuntimeStore().getClient(input.serverId);
  if (!client) throw new Error("The host is not connected");
  const sourceWorkspaceId = useSessionStore
    .getState()
    .sessions[input.serverId]?.agents.get(input.agentId)?.workspaceId;
  await client.moveAgentToWorkspace(input.agentId, input.targetWorkspaceId);
  const store = useWorkspaceLayoutStore.getState();
  if (sourceWorkspaceId && sourceWorkspaceId !== input.targetWorkspaceId) {
    const sourceKey = buildWorkspaceTabPersistenceKey({
      serverId: input.serverId,
      workspaceId: sourceWorkspaceId,
    });
    const sourceLayout = sourceKey ? store.layoutByWorkspace[sourceKey] : null;
    if (sourceKey && sourceLayout) {
      store.unpinAgent(sourceKey, input.agentId);
      store.hideAgent(sourceKey, input.agentId);
      for (const tab of collectAllTabs(sourceLayout.root)) {
        if (tab.target.kind === "agent" && tab.target.agentId === input.agentId)
          store.closeTab(sourceKey, tab.tabId);
      }
    }
  }
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.targetWorkspaceId,
  });
  if (workspaceKey) {
    const tabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: input.agentId },
      intent: "reveal",
      pin: true,
    });
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = tabId && layout ? findPaneContainingTab(layout.root, tabId) : null;
    if (pane && tabId)
      store.reorderTabsInPane(workspaceKey, pane.id, [
        tabId,
        ...pane.tabIds.filter((id) => id !== tabId),
      ]);
    useSidebarOrderStore.getState().promoteWorkspace(workspaceKey);
  }
  if (input.navigate === false) return;
  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: input.targetWorkspaceId,
    target: { kind: "agent", agentId: input.agentId },
  });
}

/** What a toast calls a session and a workspace, falling back to their ids. */
export function describeMove(input: {
  serverId: string;
  agentId: string | null;
  targetWorkspaceId: string;
}): { session: string; workspace: string } {
  const session = useSessionStore.getState().sessions[input.serverId];
  const agent = input.agentId ? session?.agents.get(input.agentId) : undefined;
  const workspace = [...(session?.workspaces.values() ?? [])].find(
    (candidate) => candidate.id === input.targetWorkspaceId,
  );
  return {
    session: agent?.title ?? input.agentId?.slice(0, 8) ?? "",
    workspace: workspace?.title ?? workspace?.name ?? input.targetWorkspaceId,
  };
}
