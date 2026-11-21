import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useCallback } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  cloneGithubProjectDirectly,
  openProjectDirectly,
  type OpenProjectResult,
  type CloneGithubProjectDirectlyInput,
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
  const upsertProject = useCallback(
    (
      targetServerId: string,
      project: Parameters<ReturnType<typeof getHostRuntimeStore>["acceptProjectSnapshot"]>[1],
    ) => {
      getHostRuntimeStore().acceptProjectSnapshot(targetServerId, project);
    },
    [],
  );
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

type CloneGithubProjectInput = Pick<
  CloneGithubProjectDirectlyInput,
  "repo" | "targetDirectory" | "cloneProtocol" | "folderName"
>;

export function useCloneGithubProject(
  serverId: string | null,
): (input: CloneGithubProjectInput) => Promise<OpenProjectResult> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const upsertProject = useCallback(
    (
      targetServerId: string,
      project: Parameters<ReturnType<typeof getHostRuntimeStore>["acceptProjectSnapshot"]>[1],
    ) => {
      getHostRuntimeStore().acceptProjectSnapshot(targetServerId, project);
    },
    [],
  );
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (input: CloneGithubProjectInput) => {
      return cloneGithubProjectDirectly({
        ...input,
        serverId: normalizedServerId,
        isConnected,
        client,
        upsertProject,
        setHasHydratedWorkspaces,
      });
    },
    [client, isConnected, normalizedServerId, setHasHydratedWorkspaces, upsertProject],
  );
}
