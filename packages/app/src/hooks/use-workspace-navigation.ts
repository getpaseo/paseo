import { useCallback } from "react";
import { router } from "expo-router";
import {
  activateNavigationWorkspaceSelection,
  getNavigationActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { buildHostWorkspaceRoute, parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";

interface NavigateToWorkspaceOptions {
  currentPathname?: string | null;
}

function shouldUseRetainedWorkspaceSwitch(input: {
  hasActiveWorkspace: boolean;
  currentPathname?: string | null;
}): boolean {
  if (!input.hasActiveWorkspace) {
    return false;
  }

  if (input.currentPathname == null) {
    return true;
  }

  return parseHostWorkspaceRouteFromPathname(input.currentPathname) !== null;
}

/**
 * Open a workspace. Once the workspace shell is mounted, switching workspaces
 * is app-level state so native-stack does not rebuild every retained screen.
 */
export function navigateToWorkspace(
  serverId: string,
  workspaceId: string,
  options: NavigateToWorkspaceOptions = {},
) {
  const activeWorkspace = getNavigationActiveWorkspaceSelection();
  if (
    shouldUseRetainedWorkspaceSwitch({
      hasActiveWorkspace: activeWorkspace !== null,
      currentPathname: options.currentPathname,
    })
  ) {
    activateNavigationWorkspaceSelection(
      { serverId, workspaceId },
      { updateBrowserHistory: true, historyMode: "push" },
    );
    return;
  }

  const href = buildHostWorkspaceRoute(serverId, workspaceId);
  router.navigate(href);
}

export function useWorkspaceNavigation() {
  return {
    navigateToWorkspace: useCallback(
      (serverId: string, workspaceId: string, options?: NavigateToWorkspaceOptions) => {
        navigateToWorkspace(serverId, workspaceId, options);
      },
      [],
    ),
  };
}
