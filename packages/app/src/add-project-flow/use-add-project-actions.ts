import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
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

/** What a submission's work reports: the project to open, or why it failed. */
type SubmissionOutcome =
  | { ok: true; project: WorkspaceProjectDescriptorPayload }
  | { ok: false; error: string };

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
  // The running submission, if any. It belongs to the open sheet and the host it started on:
  // closing the sheet or losing that host abandons it, so a late result neither navigates nor
  // blocks the next submission.
  const submissionRef = useRef<symbol | null>(null);
  useEffect(
    () => () => {
      submissionRef.current = null;
    },
    [hostId],
  );

  /** Runs one submission at a time and opens a new workspace for the project it adds. */
  const run = useCallback(
    async (serverId: string, work: () => Promise<SubmissionOutcome>, fallbackError: string) => {
      if (submissionRef.current) return;
      const submission = Symbol("add-project-submission");
      submissionRef.current = submission;
      const isCurrent = () => submissionRef.current === submission;
      setState(startAddProjectSubmission);
      let outcome: SubmissionOutcome;
      try {
        outcome = await work();
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : fallbackError;
        outcome = { ok: false, error: message };
      }
      if (!isCurrent()) return;
      submissionRef.current = null;
      if (!outcome.ok) {
        setState((state) => failAddProjectSubmission(state, outcome.error));
        return;
      }
      onClose();
      usePanelStore.getState().showMobileAgent();
      router.push(
        buildNewWorkspaceRoute({
          serverId,
          projectId: outcome.project.projectId,
          sourceDirectory: outcome.project.projectRootPath,
          displayName: outcome.project.projectDisplayName,
        }),
      );
    },
    [onClose, setState],
  );

  const openFolder = useCallback(
    (path: string) => {
      if (!hostId) return;
      void run(
        hostId,
        async () => {
          const result = await openProject(path);
          if (result.ok) return { ok: true, project: result.project };
          if (getOpenProjectFailureReason(result) === "directory_not_found") {
            return { ok: false, error: "Folder not found" };
          }
          return { ok: false, error: result.error ?? "Unable to add project" };
        },
        "Unable to add project",
      );
    },
    [hostId, openProject, run],
  );

  // The desktop folder dialog is modal to the window, so nothing else can start while it is open.
  const browse = useCallback(() => {
    if (!hostId || submissionRef.current) return;
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
      void run(
        hostId,
        async () => {
          const result = await cloneGithubProject(
            repository.cloneUrl,
            location,
            repository.cloneProtocol,
          );
          if (!result.ok) return { ok: false, error: result.error ?? "Unable to clone project" };
          rememberLocation(hostId, location);
          return { ok: true, project: result.project };
        },
        "Unable to clone project",
      );
    },
    [cloneGithubProject, hostId, rememberLocation, run],
  );

  const createFolder = useCallback(
    (name: string, location: string) => {
      if (!hostId) return;
      void run(
        hostId,
        async () => {
          if (!client) return { ok: false, error: "Unable to create folder" };
          const payload = await client.createProjectDirectory({
            parentPath: location,
            name: name.trim(),
          });
          if (payload.error || !payload.project) {
            return { ok: false, error: payload.error ?? "Unable to create folder" };
          }
          registerProjectDescriptor({
            serverId: hostId,
            project: payload.project,
            upsertProject: (serverId, project) =>
              getHostRuntimeStore().acceptProjectSnapshot(serverId, project),
            setHasHydratedWorkspaces,
          });
          rememberLocation(hostId, location);
          return { ok: true, project: payload.project };
        },
        "Unable to create folder",
      );
    },
    [client, hostId, rememberLocation, run, setHasHydratedWorkspaces],
  );

  return { openFolder, browse, clone, createFolder };
}
