import { useCallback } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { openProjectDirectly, type OpenProjectResult } from "@/hooks/open-project";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";

export function useOpenProject(
  serverId: string | null,
): (path: string) => Promise<OpenProjectResult> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const canAddProject = useSessionStore((state) =>
    normalizedServerId
      ? state.sessions[normalizedServerId]?.serverInfo?.features?.projectAdd === true
      : false,
  );
  const addEmptyProject = useSessionStore((state) => state.addEmptyProject);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (path: string) => {
      const result = await openProjectDirectly({
        serverId: normalizedServerId,
        projectPath: path,
        isConnected,
        canAddProject,
        client,
        addEmptyProject,
        mergeWorkspaces,
        setHasHydratedWorkspaces,
      });
      if (result.ok && result.workspaceId) {
        navigateToWorkspace(normalizedServerId, result.workspaceId);
      }
      return result;
    },
    [
      addEmptyProject,
      canAddProject,
      client,
      isConnected,
      mergeWorkspaces,
      normalizedServerId,
      setHasHydratedWorkspaces,
    ],
  );
}
