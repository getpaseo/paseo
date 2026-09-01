import { useMemo, useRef } from "react";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useWorkspaceDirectories } from "@/stores/session-store-hooks";
import {
  areSidebarWorkspaceSessionsEqual,
  buildSidebarWorkspaceEntries,
  selectSidebarWorkspaceSessions,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
  type SidebarWorkspaceSession,
} from "./sidebar-workspaces-view-model";

const EMPTY_ENTRIES = new Map<string, SidebarWorkspaceEntry>();
const EMPTY_SESSIONS: SidebarWorkspaceSession[] = [];
const EMPTY_PENDING_CREATE_ATTEMPTS: Record<string, never> = {};

export function useSidebarWorkspaceEntries(
  placements: readonly SidebarWorkspacePlacement[],
  enabled = true,
): ReadonlyMap<string, SidebarWorkspaceEntry> {
  const serverIds = useMemo(
    () => Array.from(new Set(placements.map((placement) => placement.serverId))),
    [placements],
  );
  const sessions = useWorkspaceDirectories(
    serverIds,
    (directories) =>
      enabled
        ? selectSidebarWorkspaceSessions(
            Object.fromEntries(
              serverIds.map((serverId) => {
                const directory = directories.get(serverId);
                return [
                  serverId,
                  {
                    workspaces: directory?.workspaces ?? new Map(),
                    workspaceAgentActivity: directory?.workspaceAgentActivity ?? new Map(),
                  },
                ];
              }),
            ),
            serverIds,
          )
        : EMPTY_SESSIONS,
    areSidebarWorkspaceSessionsEqual,
  );
  const pendingCreateAttempts = useCreateFlowStore((state) =>
    enabled ? state.pendingByDraftId : EMPTY_PENDING_CREATE_ATTEMPTS,
  );
  const previousEntriesRef = useRef<ReadonlyMap<string, SidebarWorkspaceEntry>>(EMPTY_ENTRIES);

  // Collection ownership is intentional: retained sidebars have one cheap
  // subscription to structurally shared indexes, never one session-store
  // subscription per mounted row.
  return useMemo(() => {
    if (!enabled) {
      return previousEntriesRef.current;
    }
    if (placements.length === 0 || sessions.length === 0) {
      previousEntriesRef.current = EMPTY_ENTRIES;
      return EMPTY_ENTRIES;
    }
    const entries = buildSidebarWorkspaceEntries({
      placements,
      sessions,
      pendingCreateAttempts,
      previousEntries: previousEntriesRef.current,
    });
    previousEntriesRef.current = entries;
    return entries;
  }, [enabled, pendingCreateAttempts, placements, sessions]);
}
