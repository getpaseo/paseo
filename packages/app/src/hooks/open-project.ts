import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectAddResponse } from "@getpaseo/protocol/messages";
import {
  normalizeEmptyProjectDescriptor as normalizeProjectWithoutWorkspacesDescriptor,
  type EmptyProjectDescriptor as ProjectWithoutWorkspacesDescriptor,
} from "@/stores/session-store";

type OpenProjectPayload = ProjectAddResponse["payload"];
type OpenProjectErrorCode = NonNullable<OpenProjectPayload["errorCode"]>;

export interface OpenProjectSuccess {
  ok: true;
}

export interface OpenProjectFailure {
  ok: false;
  errorCode: OpenProjectErrorCode | null;
  error: string | null;
}

export type OpenProjectResult = OpenProjectSuccess | OpenProjectFailure;

export interface OpenProjectDirectlyInput {
  serverId: string;
  projectPath: string;
  isConnected: boolean;
  canAddProject: boolean;
  client: Pick<DaemonClient, "addProject"> | null;
  addEmptyProject: (serverId: string, project: ProjectWithoutWorkspacesDescriptor) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
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

  input.addEmptyProject(
    normalizedServerId,
    normalizeProjectWithoutWorkspacesDescriptor(payload.project),
  );
  input.setHasHydratedWorkspaces(normalizedServerId, true);
  return { ok: true };
}
