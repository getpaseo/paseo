import { useCallback } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";

export { navigateToWorkspace };

export function useWorkspaceNavigation() {
  return {
    navigateToWorkspace: useCallback(
      (
        serverId: string,
        workspaceId: string,
        options?: Parameters<typeof navigateToWorkspace>[2],
      ) => {
        navigateToWorkspace(serverId, workspaceId, options);
      },
      [],
    ),
  };
}
