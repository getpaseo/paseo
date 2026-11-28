import { useCallback, useSyncExternalStore } from "react";
import {
  isWorkspaceArchiveUndoPending,
  isWorkspaceArchiveUndoRestoringAgent,
  subscribeWorkspaceArchiveIntents,
} from "@/contexts/session-workspace-upserts";

/**
 * True while this client's undo of the workspace's archive is running on the host. Until it
 * settles, the workspace's agents may still read as archived even though they are coming back.
 */
export function useWorkspaceArchiveUndoRunning(input: {
  serverId: string;
  workspaceId: string | null;
}): boolean {
  const { serverId, workspaceId } = input;
  const read = useCallback(
    () => isWorkspaceArchiveUndoPending({ serverId, workspaceId }),
    [serverId, workspaceId],
  );
  return useSyncExternalStore(subscribeWorkspaceArchiveIntents, read, read);
}

/**
 * True while this client's undo of the workspace's archive is pending and `agentId` was active
 * in that workspace when archived (excluding agents that were already archived individually).
 */
export function useWorkspaceArchiveUndoRestoringAgent(input: {
  serverId: string;
  workspaceId: string | null;
  agentId: string | null;
}): boolean {
  const { serverId, workspaceId, agentId } = input;
  const read = useCallback(
    () => isWorkspaceArchiveUndoRestoringAgent({ serverId, workspaceId, agentId }),
    [agentId, serverId, workspaceId],
  );
  return useSyncExternalStore(subscribeWorkspaceArchiveIntents, read, read);
}
