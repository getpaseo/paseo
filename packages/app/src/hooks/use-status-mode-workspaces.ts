import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import {
  buildSidebarStatusWorkspacePlacements,
  type SidebarStatusWorkspacePlacement,
  type SidebarWorkspacePlacement,
} from "./use-sidebar-workspaces-list";

const EMPTY_WORKSPACES: SidebarStatusWorkspacePlacement[] = [];
const EMPTY_STATUS_SESSIONS: StatusModeSession[] = [];
const EMPTY_PENDING_CREATE_ATTEMPTS: ReturnType<
  typeof useCreateFlowStore.getState
>["pendingByDraftId"] = {};

interface StatusModeSessionSource {
  workspaces: SessionState["workspaces"];
  workspaceAgentActivity: SessionState["workspaceAgentActivity"];
}

export interface StatusModeSession {
  serverId: string;
  workspaces: SessionState["workspaces"];
  workspaceAgentActivity: SessionState["workspaceAgentActivity"];
}

export function selectStatusModeSessions(
  sessions: Record<string, StatusModeSessionSource | undefined>,
  serverIds: readonly string[],
): StatusModeSession[] {
  const statusSessions: StatusModeSession[] = [];
  for (const serverId of serverIds) {
    const session = sessions[serverId];
    if (!session) {
      continue;
    }
    statusSessions.push({
      serverId,
      workspaces: session.workspaces,
      workspaceAgentActivity: session.workspaceAgentActivity,
    });
  }
  return statusSessions;
}

export function areStatusModeSessionsEqual(
  left: readonly StatusModeSession[],
  right: readonly StatusModeSession[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftSession = left[index];
    const rightSession = right[index];
    if (
      !leftSession ||
      !rightSession ||
      leftSession.serverId !== rightSession.serverId ||
      leftSession.workspaces !== rightSession.workspaces ||
      leftSession.workspaceAgentActivity !== rightSession.workspaceAgentActivity
    ) {
      return false;
    }
  }
  return true;
}

export function useStatusModeWorkspacePlacements(input: {
  placements: SidebarWorkspacePlacement[];
  enabled?: boolean;
}): SidebarStatusWorkspacePlacement[] {
  const isEnabled = input.enabled !== false && input.placements.length > 0;
  const serverIds = useMemo(
    () => Array.from(new Set(input.placements.map((placement) => placement.serverId))),
    [input.placements],
  );
  const statusSessions = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      isEnabled ? selectStatusModeSessions(state.sessions, serverIds) : EMPTY_STATUS_SESSIONS,
    areStatusModeSessionsEqual,
  );
  const pendingCreateAttempts = useCreateFlowStore((state) =>
    isEnabled ? state.pendingByDraftId : EMPTY_PENDING_CREATE_ATTEMPTS,
  );

  return useMemo(() => {
    if (!isEnabled) {
      return EMPTY_WORKSPACES;
    }

    return buildSidebarStatusWorkspacePlacements({
      placements: input.placements,
      sessions: statusSessions,
      pendingCreateAttempts,
    });
  }, [input.placements, isEnabled, pendingCreateAttempts, statusSessions]);
}
