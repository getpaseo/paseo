import { useCallback } from "react";
import { router } from "expo-router";
import { buildHostWorkspaceRoute, buildHostAgentDetailRoute } from "@/utils/host-routes";
import { useSessionStore } from "@/stores/session-store";

/**
 * Navigate to a workspace screen. Uses router.navigate() which,
 * combined with getId on the workspace Stack.Screen, ensures:
 * - Only one instance of each workspace exists in the stack
 * - History is preserved (back button works)
 * - No duplicate workspace screens
 *
 * If there is already an active (non-archived) agent running in the workspace,
 * navigates directly to that agent instead of showing the blank "New Agent" state.
 */
export function navigateToWorkspace(serverId: string, workspaceId: string) {
  // If there's already an active agent in this workspace, navigate to it directly
  const agents = useSessionStore.getState().sessions[serverId]?.agents;
  if (agents) {
    const activeAgent = Array.from(agents.values()).find(
      (a) => a.cwd === workspaceId && a.archivedAt == null,
    );
    if (activeAgent) {
      router.navigate(buildHostAgentDetailRoute(serverId, activeAgent.id, workspaceId) as any);
      return;
    }
  }

  const href = buildHostWorkspaceRoute(serverId, workspaceId);
  router.navigate(href);
}

export function useWorkspaceNavigation() {
  return {
    navigateToWorkspace: useCallback((serverId: string, workspaceId: string) => {
      navigateToWorkspace(serverId, workspaceId);
    }, []),
  };
}
