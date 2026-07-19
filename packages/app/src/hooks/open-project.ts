import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ProjectGithubCloneProtocol,
  ProjectAddResponse,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";
import {
  normalizeEmptyProjectDescriptor as normalizeProjectWithoutWorkspacesDescriptor,
  type EmptyProjectDescriptor as ProjectWithoutWorkspacesDescriptor,
} from "@/stores/session-store";

type OpenProjectPayload = ProjectAddResponse["payload"];
type OpenProjectErrorCode = NonNullable<OpenProjectPayload["errorCode"]>;

export interface OpenProjectSuccess {
  ok: true;
  project: WorkspaceProjectDescriptorPayload;
}

export interface OpenProjectFailure {
  ok: false;
  errorCode: OpenProjectErrorCode | null;
  error: string | null;
}

export type OpenProjectResult = OpenProjectSuccess | OpenProjectFailure;
export type OpenProjectFailureReason = "directory_not_found" | "open_failed";
export type { ProjectGithubCloneProtocol };

export function getOpenProjectFailureReason(
  result: OpenProjectResult,
): OpenProjectFailureReason | null {
  if (result.ok) {
    return null;
  }

  if (result.errorCode === "directory_not_found") {
    return "directory_not_found";
  }

  return "open_failed";
}

export interface OpenProjectDirectlyInput {
  serverId: string;
  projectPath: string;
  isConnected: boolean;
  canAddProject: boolean;
  client: Pick<DaemonClient, "addProject"> | null;
  addEmptyProject: (serverId: string, project: ProjectWithoutWorkspacesDescriptor) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
}

interface ProjectRegistrationCallbacks {
  serverId: string;
  isConnected: boolean;
  addEmptyProject: (serverId: string, project: ProjectWithoutWorkspacesDescriptor) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
}

export interface RegisterProjectDescriptorInput {
  serverId: string;
  project: WorkspaceProjectDescriptorPayload;
  addEmptyProject: (serverId: string, project: ProjectWithoutWorkspacesDescriptor) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
}

export function registerProjectDescriptor(input: RegisterProjectDescriptorInput): boolean {
  const serverId = input.serverId.trim();
  if (!serverId) return false;
  input.addEmptyProject(serverId, normalizeProjectWithoutWorkspacesDescriptor(input.project));
  input.setHasHydratedWorkspaces(serverId, true);
  return true;
}

export interface CloneGithubProjectDirectlyInput extends ProjectRegistrationCallbacks {
  repo: string;
  targetDirectory: string;
  cloneProtocol?: ProjectGithubCloneProtocol;
  client: Pick<DaemonClient, "cloneGithubProject"> | null;
}

export async function openProjectDirectly(
  input: OpenProjectDirectlyInput,
): Promise<OpenProjectResult> {
  const normalizedServerId = input.serverId.trim();
  const trimmedPath = input.projectPath.trim();
  if (!normalizedServerId || !trimmedPath || !input.client || !input.isConnected) {
    return { ok: false, errorCode: null, error: null };
  }

  if (!input.canAddProject) {
    return {
      ok: false,
      errorCode: null,
      error: "Update the host to add projects without creating a workspace.",
    };
  }

  const payload = await input.client.addProject(trimmedPath);
  if (payload.error || !payload.project) {
    return {
      ok: false,
      errorCode: payload.errorCode ?? null,
      error: payload.error,
    };
  }

  const registered = registerProjectDescriptor({
    serverId: normalizedServerId,
    project: payload.project,
    addEmptyProject: input.addEmptyProject,
    setHasHydratedWorkspaces: input.setHasHydratedWorkspaces,
  });
  return registered
    ? { ok: true, project: payload.project }
    : { ok: false, errorCode: null, error: "Unable to register project" };
}

export async function cloneGithubProjectDirectly(
  input: CloneGithubProjectDirectlyInput,
): Promise<OpenProjectResult> {
  const normalizedServerId = input.serverId.trim();
  const trimmedRepo = input.repo.trim();
  const trimmedTargetDirectory = input.targetDirectory.trim();
  if (
    !normalizedServerId ||
    !trimmedRepo ||
    !trimmedTargetDirectory ||
    !input.client ||
    !input.isConnected
  ) {
    return { ok: false, errorCode: null, error: null };
  }

  const payload = await input.client.cloneGithubProject({
    repo: trimmedRepo,
    targetDirectory: trimmedTargetDirectory,
    ...(input.cloneProtocol ? { cloneProtocol: input.cloneProtocol } : {}),
  });
  if (payload.error || !payload.project) {
    return { ok: false, errorCode: null, error: payload.error };
  }

  const registered = registerProjectDescriptor({
    serverId: normalizedServerId,
    project: payload.project,
    addEmptyProject: input.addEmptyProject,
    setHasHydratedWorkspaces: input.setHasHydratedWorkspaces,
  });
  return registered
    ? { ok: true, project: payload.project }
    : { ok: false, errorCode: null, error: "Unable to register project" };
}
