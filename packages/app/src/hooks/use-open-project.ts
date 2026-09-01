import { useCallback } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useServerFeature } from "@/stores/session-store-hooks";
import {
  acceptProjectSnapshot as upsertProject,
  publishWorkspaceHydration as setHasHydratedWorkspaces,
} from "@/runtime/session-data";
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
  const supportsProjectAdd = useServerFeature(normalizedServerId, "projectAdd");
  const supportsStableProjectIdentity = useServerFeature(
    normalizedServerId,
    "stableProjectIdentity",
  );
  const canAddProject = supportsProjectAdd && supportsStableProjectIdentity;

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
    [canAddProject, client, isConnected, normalizedServerId],
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
    [client, isConnected, normalizedServerId],
  );
}
