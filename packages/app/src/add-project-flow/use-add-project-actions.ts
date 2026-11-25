import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { router } from "expo-router";
import type { WorkspaceProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import { pickDirectory } from "@/desktop/pick-directory";
import { getOpenProjectFailureReason, registerProjectDescriptor } from "@/hooks/open-project";
import { useCloneGithubProject, useOpenProject } from "@/hooks/use-open-project";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { useAddProjectFlowStore } from "@/stores/add-project-flow-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import {
  failAddProjectSubmission,
  startAddProjectSubmission,
  type AddProjectFlowState,
  type GithubRepositoryChoice,
} from "./model";

/** A failure found before any work starts, shown the same way as one the host reports. */
function rejectSubmission(state: AddProjectFlowState, message: string): AddProjectFlowState {
  return failAddProjectSubmission(startAddProjectSubmission(state), message);
}

export interface AddProjectActions {
  openFolder: (path: string) => void;
  browse: () => void;
  clone: (repository: GithubRepositoryChoice, location: string) => void;
  /** Expects a name that passed `validateNewFolderName`; the New folder tab only offers those. */
  createFolder: (name: string, location: string) => void;
}

/**
 * The three ways a project gets added. Each one records its progress and failure in the flow
 * state and, on success, closes the flow and opens a new workspace for the project.
 */
export function useAddProjectActions(input: {
  hostId: string | null;
  setState: Dispatch<SetStateAction<AddProjectFlowState>>;
  onClose: () => void;
}): AddProjectActions {
  const { hostId, setState, onClose } = input;
  const client = useHostRuntimeClient(hostId ?? "");
  const openProject = useOpenProject(hostId);
  const cloneGithubProject = useCloneGithubProject(hostId);
  const setHasHydratedWorkspaces = useSessionStore((store) => store.setHasHydratedWorkspaces);
  const rememberLocation = useAddProjectFlowStore((store) => store.rememberLocation);
  const inFlightRef = useRef(false);

  const openNewWorkspace = useCallback(
    (serverId: string, project: WorkspaceProjectDescriptorPayload) => {
      onClose();
      usePanelStore.getState().showMobileAgent();
      router.push(
        buildNewWorkspaceRoute({
          serverId,
          projectId: project.projectId,
          sourceDirectory: project.projectRootPath,
          displayName: project.projectDisplayName,
        }),
      );
    },
    [onClose],
  );

  /** Runs one submission at a time; a thrown error or returned message becomes the failure. */
  const run = useCallback(
    async (work: () => Promise<string | null>, fallbackError: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setState(startAddProjectSubmission);
      try {
        const failure = await work();
        if (failure) setState((state) => failAddProjectSubmission(state, failure));
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : fallbackError;
        setState((state) => failAddProjectSubmission(state, message));
      } finally {
        inFlightRef.current = false;
      }
    },
    [setState],
  );

  const openFolder = useCallback(
    (path: string) => {
      if (!hostId) return;
      void run(async () => {
        const result = await openProject(path);
        if (result.ok) {
          openNewWorkspace(hostId, result.project);
          return null;
        }
        return getOpenProjectFailureReason(result) === "directory_not_found"
          ? "Folder not found"
          : "Unable to add project";
      }, "Unable to add project");
    },
    [hostId, openNewWorkspace, openProject, run],
  );

  const browse = useCallback(() => {
    if (!hostId || inFlightRef.current) return;
    void (async () => {
      try {
        const path = await pickDirectory();
        if (path) openFolder(path);
      } catch {
        setState((state) => rejectSubmission(state, "Unable to browse for a folder"));
      }
    })();
  }, [hostId, openFolder, setState]);

  const clone = useCallback(
    (repository: GithubRepositoryChoice, location: string) => {
      if (!hostId) return;
      void run(async () => {
        const result = await cloneGithubProject(
          repository.cloneUrl,
          location,
          repository.cloneProtocol,
        );
        if (!result.ok) return result.error ?? "Unable to clone project";
        rememberLocation(hostId, location);
        openNewWorkspace(hostId, result.project);
        return null;
      }, "Unable to clone project");
    },
    [cloneGithubProject, hostId, openNewWorkspace, rememberLocation, run],
  );

  const createFolder = useCallback(
    (name: string, location: string) => {
      if (!hostId || !client) return;
      void run(async () => {
        const payload = await client.createProjectDirectory({
          parentPath: location,
          name: name.trim(),
        });
        if (payload.error || !payload.project) return payload.error ?? "Unable to create folder";
        registerProjectDescriptor({
          serverId: hostId,
          project: payload.project,
          upsertProject: (serverId, project) =>
            getHostRuntimeStore().acceptProjectSnapshot(serverId, project),
          setHasHydratedWorkspaces,
        });
        rememberLocation(hostId, location);
        openNewWorkspace(hostId, payload.project);
        return null;
      }, "Unable to create folder");
    },
    [client, hostId, openNewWorkspace, rememberLocation, run, setHasHydratedWorkspaces],
  );

  return { openFolder, browse, clone, createFolder };
}
