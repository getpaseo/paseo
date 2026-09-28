import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export interface MoveWorkspaceSessionsResult {
  moved: number;
  archivedSource: boolean;
}

/**
 * Moves every open session of one workspace into another, like dragging it across. The
 * emptied workspace is archived when that only hides it; a Paseo worktree is kept, since
 * archiving would delete its directory and whatever is uncommitted there.
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
  const source = [...(session?.workspaces.values() ?? [])].find(
    (workspace) => workspace.id === sourceWorkspaceId,
  );
  const archivable = source && source.workspaceKind !== "worktree";
  if (archivable) await client.archiveWorkspace(sourceWorkspaceId);
  return { moved: agentIds.length, archivedSource: Boolean(archivable) };
}

/** One session, dragged from its tab onto another workspace. */
export async function moveSessionToWorkspace(input: {
  serverId: string;
  agentId: string;
  targetWorkspaceId: string;
}): Promise<void> {
  const client = getHostRuntimeStore().getClient(input.serverId);
  if (!client) throw new Error("The host is not connected");
  await client.moveAgentToWorkspace(input.agentId, input.targetWorkspaceId);
}
