import { useTranslation } from "react-i18next";
import { useWorkspaceCreations } from "@/workspace-creation";
import { creatingSidebarEntry } from "@/workspace-creation/presentation";
import { useMemo, useRef } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore } from "@/stores/session-store";
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
  const { t } = useTranslation();
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
  const creations = useWorkspaceCreations();
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
    const entries = new Map(
      buildSidebarWorkspaceEntries({
        placements,
        sessions,
        pendingCreateAttempts,
        workspaceCreations: creations,
        previousEntries: previousEntriesRef.current,
      }),
    );
    for (const placement of placements) {
      if (entries.has(placement.workspaceKey)) continue;
      const creating = creations.some(
        (creation) =>
          creation.serverId === placement.serverId &&
          creation.workspaceId === placement.workspaceId &&
          !creation.workspaceObserved,
      );
      if (creating) entries.set(placement.workspaceKey, creatingSidebarEntry(placement, t));
    }
    previousEntriesRef.current = entries;
    return entries;
  }, [enabled, pendingCreateAttempts, placements, sessions, creations, t]);
}
