import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
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
  for (const agentId of agentIds) {
    await client.moveAgentToWorkspace(agentId, targetWorkspaceId);
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
}): Promise<void> {
  const client = getHostRuntimeStore().getClient(input.serverId);
  if (!client) throw new Error("The host is not connected");
  await client.moveAgentToWorkspace(input.agentId, input.targetWorkspaceId);
  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: input.targetWorkspaceId,
    target: { kind: "agent", agentId: input.agentId },
  });
}
