import { useMemo, useRef } from "react";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import {
  areSidebarWorkspaceSessionsEqual,
  buildSidebarWorkspaceEntries,
  selectSidebarWorkspaceSessions,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
  type SidebarWorkspaceSession,
  type WorkspaceSetupStatusByKey,
} from "./sidebar-workspaces-view-model";

const EMPTY_ENTRIES = new Map<string, SidebarWorkspaceEntry>();
const EMPTY_SESSIONS: SidebarWorkspaceSession[] = [];
const EMPTY_PENDING_CREATE_ATTEMPTS: Record<string, never> = {};
const EMPTY_WORKSPACE_SETUP_STATUSES: WorkspaceSetupStatusByKey = {};

export function useSidebarWorkspaceEntries(
  placements: readonly SidebarWorkspacePlacement[],
  enabled = true,
): ReadonlyMap<string, SidebarWorkspaceEntry> {
  const serverIds = useMemo(
    () => Array.from(new Set(placements.map((placement) => placement.serverId))),
    [placements],
  );
  const sessions = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      enabled ? selectSidebarWorkspaceSessions(state.sessions, serverIds) : EMPTY_SESSIONS,
    areSidebarWorkspaceSessionsEqual,
  );
  const pendingCreateAttempts = useCreateFlowStore((state) =>
    enabled ? state.pendingByDraftId : EMPTY_PENDING_CREATE_ATTEMPTS,
  );
  const workspaceSetupKeys = useMemo(
    () => placements.map((placement) => `${placement.serverId}:${placement.workspaceId}`),
    [placements],
  );
  const workspaceSetupStatuses = useStoreWithEqualityFn(
    useWorkspaceSetupStore,
    (state) => {
      if (!enabled) return EMPTY_WORKSPACE_SETUP_STATUSES;
      const statuses: Record<string, WorkspaceSetupStatusByKey[string]> = {};
      for (const key of workspaceSetupKeys) {
        const status = state.snapshots[key]?.status;
        if (status) statuses[key] = status;
      }
      return statuses;
    },
    shallow,
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
      workspaceSetupStatuses,
      previousEntries: previousEntriesRef.current,
    });
    previousEntriesRef.current = entries;
    return entries;
  }, [enabled, pendingCreateAttempts, placements, sessions, workspaceSetupStatuses]);
}
