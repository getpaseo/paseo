import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectAddResponse } from "@getpaseo/protocol/messages";
import {
  normalizeEmptyProjectDescriptor as normalizeProjectWithoutWorkspacesDescriptor,
  normalizeWorkspaceDescriptor,
  type EmptyProjectDescriptor as ProjectWithoutWorkspacesDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";

type OpenProjectPayload = ProjectAddResponse["payload"];
type OpenProjectErrorCode = NonNullable<OpenProjectPayload["errorCode"]>;

export interface OpenProjectSuccess {
  ok: true;
  workspaceId: string | null;
}

export interface OpenProjectFailure {
  ok: false;
  errorCode: OpenProjectErrorCode | null;
  error: string | null;
}

export type OpenProjectResult = OpenProjectSuccess | OpenProjectFailure;
export type OpenProjectFailureReason = "directory_not_found" | "open_failed";

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
  client: Pick<DaemonClient, "addProject" | "createWorkspace" | "getCheckoutStatus"> | null;
  addEmptyProject: (serverId: string, project: ProjectWithoutWorkspacesDescriptor) => void;
  mergeWorkspaces: (serverId: string, workspaces: WorkspaceDescriptor[]) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
}

async function isExistingGitWorktree(
  client: Pick<DaemonClient, "getCheckoutStatus">,
  path: string,
): Promise<boolean> {
  try {
    const status = await client.getCheckoutStatus(path);
    return (
      status.isGit === true &&
      typeof status.mainRepoRoot === "string" &&
      status.mainRepoRoot.length > 0
    );
  } catch {
    return false;
  }
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

  if (await isExistingGitWorktree(input.client, trimmedPath)) {
    const payload = await input.client.createWorkspace({
      source: { kind: "directory", path: trimmedPath },
    });
    if (payload.error || !payload.workspace) {
      return {
        ok: false,
        errorCode: null,
        error: payload.error,
      };
    }
    const workspace = normalizeWorkspaceDescriptor(payload.workspace);
    input.mergeWorkspaces(normalizedServerId, [workspace]);
    input.setHasHydratedWorkspaces(normalizedServerId, true);
    return { ok: true, workspaceId: workspace.id };
  }

  const payload = await input.client.addProject(trimmedPath);
  if (payload.error || !payload.project) {
    return {
      ok: false,
      errorCode: payload.errorCode ?? null,
      error: payload.error,
    };
  }

  input.addEmptyProject(
    normalizedServerId,
    normalizeProjectWithoutWorkspacesDescriptor(payload.project),
  );
  input.setHasHydratedWorkspaces(normalizedServerId, true);
  return { ok: true, workspaceId: null };
}
