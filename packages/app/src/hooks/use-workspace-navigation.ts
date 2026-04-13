import { useCallback } from "react";
import { router } from "expo-router";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

/**
 * Navigate to a workspace screen. Uses router.navigate() which,
 * combined with getId on the workspace Stack.Screen, ensures:
 * - Only one instance of each workspace exists in the stack
 * - History is preserved (back button works)
 * - No duplicate workspace screens
 */
export function navigateToWorkspace(serverId: string, workspaceId: string) {
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
