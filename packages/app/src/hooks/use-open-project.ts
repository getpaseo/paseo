import { useCallback } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { generateDraftId } from "@/stores/draft-keys";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { openProjectDirectly, type OpenProjectResult } from "@/hooks/open-project";

export function useOpenProject(
  serverId: string | null,
): (path: string) => Promise<OpenProjectResult> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (path: string) => {
      return openProjectDirectly({
        serverId: normalizedServerId,
        projectPath: path,
        isConnected,
        client,
        mergeWorkspaces,
        setHasHydratedWorkspaces,
        openDraftTab: (workspaceKey: string) =>
          useWorkspaceLayoutStore.getState().openTabFocused(workspaceKey, {
            kind: "draft",
            draftId: generateDraftId(),
          }),
        navigateToWorkspace,
      });
    },
    [client, isConnected, mergeWorkspaces, normalizedServerId, setHasHydratedWorkspaces],
  );
}
