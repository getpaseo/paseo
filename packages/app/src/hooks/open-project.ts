import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ProjectAddResponse,
  WorkspaceGithubCloneProtocol,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";
import {
  normalizeEmptyProjectDescriptor as normalizeProjectWithoutWorkspacesDescriptor,
  normalizeWorkspaceDescriptor,
  type EmptyProjectDescriptor as ProjectWithoutWorkspacesDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { generateDraftId } from "@/stores/draft-keys";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import { buildWorkspaceTabPersistenceKey } from "@/stores/workspace-tabs-store";

type OpenProjectPayload = ProjectAddResponse["payload"];
type OpenProjectErrorCode = NonNullable<OpenProjectPayload["errorCode"]>;
type WorkspaceOpenPayload =
  | Awaited<ReturnType<DaemonClient["openProject"]>>
  | Awaited<ReturnType<DaemonClient["cloneGithubWorkspace"]>>;

export interface OpenProjectSuccess {
  ok: true;
}

export interface OpenProjectFailure {
  ok: false;
  errorCode: OpenProjectErrorCode | null;
  error: string | null;
}

export type OpenProjectResult = OpenProjectSuccess | OpenProjectFailure;
export type OpenProjectFailureReason = "directory_not_found" | "open_failed";
export type { WorkspaceGithubCloneProtocol };

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

interface WorkspaceOpenCallbacks {
  serverId: string;
  isConnected: boolean;
  mergeWorkspaces: (serverId: string, workspaces: Iterable<WorkspaceDescriptor>) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => string;
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

export interface OpenGithubRepoDirectlyInput extends WorkspaceOpenCallbacks {
  repo: string;
  targetDirectory: string;
  cloneProtocol?: WorkspaceGithubCloneProtocol;
  client: Pick<DaemonClient, "cloneGithubWorkspace"> | null;
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

  registerProjectDescriptor({
    serverId: normalizedServerId,
    project: payload.project,
    addEmptyProject: input.addEmptyProject,
    setHasHydratedWorkspaces: input.setHasHydratedWorkspaces,
  });
  return { ok: true };
}

function finishWorkspaceOpen(
  input: WorkspaceOpenCallbacks,
  payload: WorkspaceOpenPayload,
): boolean {
  const normalizedServerId = input.serverId.trim();
  if (!normalizedServerId || payload.error || !payload.workspace) {
    return false;
  }

  const workspace = normalizeWorkspaceDescriptor(payload.workspace);
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: normalizedServerId,
    workspaceId: workspace.id,
  });
  if (!workspaceKey) {
    return false;
  }

  input.mergeWorkspaces(normalizedServerId, [workspace]);
  input.setHasHydratedWorkspaces(normalizedServerId, true);
  input.navigateToWorkspace({
    serverId: normalizedServerId,
    workspaceId: workspace.id,
    target: { kind: "draft", draftId: generateDraftId() },
  });
  return true;
}

export async function openGithubRepoDirectly(input: OpenGithubRepoDirectlyInput): Promise<boolean> {
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
    return false;
  }

  const payload = await input.client.cloneGithubWorkspace({
    repo: trimmedRepo,
    targetDirectory: trimmedTargetDirectory,
    ...(input.cloneProtocol ? { cloneProtocol: input.cloneProtocol } : {}),
  });
  return finishWorkspaceOpen(input, payload);
}
