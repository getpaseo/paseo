import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore } from "@/stores/session-store";
import {
  areSidebarWorkspaceSessionsEqual,
  buildSidebarWorkspaceEntries,
  selectSidebarWorkspaceSessions,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
} from "./sidebar-workspaces-view-model";

const EMPTY_ENTRIES = new Map<string, SidebarWorkspaceEntry>();

export function useSidebarWorkspaceEntries(
  placements: readonly SidebarWorkspacePlacement[],
): ReadonlyMap<string, SidebarWorkspaceEntry> {
  const serverIds = useMemo(
    () => Array.from(new Set(placements.map((placement) => placement.serverId))),
    [placements],
  );
  const sessions = useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectSidebarWorkspaceSessions(state.sessions, serverIds),
    areSidebarWorkspaceSessionsEqual,
  );
  const pendingCreateAttempts = useCreateFlowStore((state) => state.pendingByDraftId);

  // Collection ownership is intentional: retained sidebars have one cheap
  // subscription to structurally shared indexes, never one session-store
  // subscription per mounted row.
  return useMemo(() => {
    if (placements.length === 0 || sessions.length === 0) {
      return EMPTY_ENTRIES;
    }
    return buildSidebarWorkspaceEntries({
      placements,
      sessions,
      pendingCreateAttempts,
    });
  }, [pendingCreateAttempts, placements, sessions]);
}
