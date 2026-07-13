import { useCallback } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { generateDraftId } from "@/stores/draft-keys";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  openGithubRepoDirectly,
  openProjectDirectly,
  type OpenProjectResult,
  type WorkspaceGithubCloneProtocol,
} from "@/hooks/open-project";

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
        setHasHydratedWorkspaces,
      });
      return result;
    },
    [
      addEmptyProject,
      canAddProject,
      client,
      isConnected,
      normalizedServerId,
      setHasHydratedWorkspaces,
    ],
  );
}

export function useOpenGithubRepo(
  serverId: string | null,
): (
  repo: string,
  targetDirectory: string,
  cloneProtocol?: WorkspaceGithubCloneProtocol,
) => Promise<boolean> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);
  const openDraftTab = useCallback((workspaceKey: string) => {
    return useWorkspaceLayoutStore.getState().openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: generateDraftId(),
    });
  }, []);

  return useCallback(
    async (repo: string, targetDirectory: string, cloneProtocol?: WorkspaceGithubCloneProtocol) => {
      return openGithubRepoDirectly({
        serverId: normalizedServerId,
        repo,
        targetDirectory,
        ...(cloneProtocol ? { cloneProtocol } : {}),
        isConnected,
        client,
        mergeWorkspaces,
        setHasHydratedWorkspaces,
        openDraftTab,
        navigateToWorkspace,
      });
    },
    [
      client,
      isConnected,
      mergeWorkspaces,
      normalizedServerId,
      openDraftTab,
      setHasHydratedWorkspaces,
    ],
  );
}
