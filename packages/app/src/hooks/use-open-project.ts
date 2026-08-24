import { useCallback } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  cloneGithubProjectDirectly,
  openProjectDirectly,
  type OpenProjectResult,
  type ProjectGithubCloneProtocol,
} from "@/hooks/open-project";

export function useOpenProject(
  serverId: string | null,
): (path: string) => Promise<OpenProjectResult> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const canAddProject = useSessionStore((state) =>
    normalizedServerId
      ? state.sessions[normalizedServerId]?.serverInfo?.features?.projectAdd === true &&
        state.sessions[normalizedServerId]?.serverInfo?.features?.stableProjectIdentity === true
      : false,
  );
  const upsertProject = useSessionStore((state) => state.upsertProject);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (path: string) => {
      const result = await openProjectDirectly({
        serverId: normalizedServerId,
        projectPath: path,
        isConnected,
        canAddProject,
        client,
        upsertProject,
        setHasHydratedWorkspaces,
      });
      return result;
    },
    [
      upsertProject,
      canAddProject,
      client,
      isConnected,
      normalizedServerId,
      setHasHydratedWorkspaces,
    ],
  );
}

export function useCloneGithubProject(
  serverId: string | null,
): (
  repo: string,
  targetDirectory: string,
  cloneProtocol?: ProjectGithubCloneProtocol,
) => Promise<OpenProjectResult> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const upsertProject = useSessionStore((state) => state.upsertProject);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (repo: string, targetDirectory: string, cloneProtocol?: ProjectGithubCloneProtocol) => {
      return cloneGithubProjectDirectly({
        serverId: normalizedServerId,
        repo,
        targetDirectory,
        ...(cloneProtocol ? { cloneProtocol } : {}),
        isConnected,
        client,
        upsertProject,
        setHasHydratedWorkspaces,
      });
    },
    [client, isConnected, normalizedServerId, setHasHydratedWorkspaces, upsertProject],
  );
}
