import { useCallback, useSyncExternalStore } from "react";
import {
  isWorkspaceArchiveUndoPending,
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
