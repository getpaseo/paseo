/**
 * Transient focus target recorded by a Live Activity deep link before `navigateToAgent`.
 * `agent-stream/view.tsx` reads it to highlight the matching `PermissionRequestCard` and
 * action button. It never submits a permission response by itself; a card clears its own
 * focus when it unmounts (the request resolved) or the user presses any action.
 */

import { create } from "zustand";
import { useShallow } from "zustand/shallow";

export interface LiveActivityFocusTarget {
  serverId: string;
  agentId: string;
  requestId: string;
  actionId?: string;
}

export interface LiveActivityFocusRouteParams {
  source: string;
  serverId: string;
  agentId: string;
  permissionRequestId: string;
  permissionActionId?: string;
}

/**
 * A Live Activity tap carries `source=live-activity` and `permissionRequestId`; other entries
 * to the agent route (in-app navigation, notifications, plain agent links) do not.
 */
export function resolveLiveActivityFocusTarget(
  params: LiveActivityFocusRouteParams,
): LiveActivityFocusTarget | null {
  if (params.source !== "live-activity" || !params.permissionRequestId) {
    return null;
  }
  return {
    serverId: params.serverId,
    agentId: params.agentId,
    requestId: params.permissionRequestId,
    actionId: params.permissionActionId,
  };
}

interface LiveActivityFocusMatch {
  agentId: string;
  requestId: string;
}

interface LiveActivityFocusStoreState {
  focus: LiveActivityFocusTarget | null;
  setFocus: (target: LiveActivityFocusTarget) => void;
  clearFocus: (match: LiveActivityFocusMatch) => void;
}

export const useLiveActivityFocusStore = create<LiveActivityFocusStoreState>((set) => ({
  focus: null,
  setFocus: (target) => set({ focus: target }),
  clearFocus: (match) =>
    set((state) =>
      state.focus !== null &&
      state.focus.agentId === match.agentId &&
      state.focus.requestId === match.requestId
        ? { focus: null }
        : state,
    ),
}));

export interface LiveActivityPermissionFocus {
  isFocused: boolean;
  focusedActionId: string | undefined;
}

const UNFOCUSED: LiveActivityPermissionFocus = { isFocused: false, focusedActionId: undefined };

/** Matches `PermissionRequestCard` by agentId + requestId, per the fixed fleet-mode contract. */
export function useLiveActivityPermissionFocus(
  agentId: string,
  requestId: string,
): LiveActivityPermissionFocus {
  return useLiveActivityFocusStore(
    useShallow((state) => {
      const { focus } = state;
      if (focus === null || focus.agentId !== agentId || focus.requestId !== requestId) {
        return UNFOCUSED;
      }
      return { isFocused: true, focusedActionId: focus.actionId };
    }),
  );
}
