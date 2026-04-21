import type { WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId, normalizeWorkspacePath } from "@/utils/workspace-identity";

export type WorkspaceAuthorityResult = {
  workspaceId: string;
  workspaceDirectory: string;
  workspace: WorkspaceDescriptor;
};

export type WorkspaceExecutionAuthorityFailureReason =
  | "workspace_id_missing"
  | "workspace_missing"
  | "workspace_directory_missing";

export type WorkspaceExecutionAuthorityResult =
  | { ok: true; authority: WorkspaceAuthorityResult }
  | {
      ok: false;
      reason: WorkspaceExecutionAuthorityFailureReason;
      message: string;
    };

export function resolveWorkspaceRouteId(input: {
  routeWorkspaceId: string | null | undefined;
}): string | null {
  return normalizeWorkspaceOpaqueId(input.routeWorkspaceId);
}

export function resolveWorkspaceIdByExecutionDirectory(input: {
  workspaces: Iterable<WorkspaceDescriptor> | null | undefined;
  workspaceDirectory: string | null | undefined;
}): string | null {
  const normalizedWorkspaceDirectory = normalizeWorkspacePath(input.workspaceDirectory);
  if (!normalizedWorkspaceDirectory) {
    return null;
  }

  for (const workspace of input.workspaces ?? []) {
    if (normalizeWorkspacePath(workspace.workspaceDirectory) === normalizedWorkspaceDirectory) {
      return workspace.id;
    }
  }

  return null;
}

export function resolveWorkspaceMapKeyByIdentity(input: {
  workspaces: Map<string, WorkspaceDescriptor> | null | undefined;
  workspaceId: string | null | undefined;
}): string | null {
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!normalizedWorkspaceId) {
    return null;
  }

  const workspaces = input.workspaces;
  if (!workspaces) {
    return null;
  }

  if (workspaces.has(normalizedWorkspaceId)) {
    return normalizedWorkspaceId;
  }

  for (const [workspaceKey, workspace] of workspaces) {
    if (normalizeWorkspaceOpaqueId(workspace.id) === normalizedWorkspaceId) {
      return workspaceKey;
    }
  }

  return null;
}

export function getWorkspaceExecutionAuthority(
  input:
    | {
        workspace: WorkspaceDescriptor | null | undefined;
      }
    | {
        workspaces: Map<string, WorkspaceDescriptor> | undefined;
        workspaceId: string | null | undefined;
      },
): WorkspaceExecutionAuthorityResult {
  const workspace =
    "workspace" in input
      ? input.workspace
      : (() => {
          const workspaceKey = resolveWorkspaceMapKeyByIdentity({
            workspaces: input.workspaces,
            workspaceId: input.workspaceId,
          });
          if (!workspaceKey) {
            return null;
          }
          return input.workspaces?.get(workspaceKey) ?? null;
        })();

  if ("workspaces" in input) {
    const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
    if (!normalizedWorkspaceId) {
      return {
        ok: false,
        reason: "workspace_id_missing",
        message: "Workspace id is required.",
      };
    }
  }

  if (!workspace) {
    return {
      ok: false,
      reason: "workspace_missing",
      message:
        "workspaces" in input
          ? `Workspace not found: ${String(input.workspaceId ?? "")}`
          : "Workspace not found.",
    };
  }

  const workspaceDirectory = normalizeWorkspacePath(workspace.workspaceDirectory);
  if (!workspaceDirectory) {
    return {
      ok: false,
      reason: "workspace_directory_missing",
      message: `Workspace directory is missing for workspace ${workspace.id}`,
    };
  }

  return {
    ok: true,
    authority: {
      workspaceId: workspace.id,
      workspaceDirectory,
      workspace,
    },
  };
}

export function requireWorkspaceExecutionAuthority(
  input:
    | {
        workspace: WorkspaceDescriptor | null | undefined;
      }
    | {
        workspaces: Map<string, WorkspaceDescriptor> | undefined;
        workspaceId: string | null | undefined;
      },
): WorkspaceAuthorityResult {
  const result = getWorkspaceExecutionAuthority(input);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.authority;
}

export function resolveWorkspaceExecutionDirectory(input: {
  workspaceDirectory: string | null | undefined;
}): string | null {
  return normalizeWorkspacePath(input.workspaceDirectory);
}

export function requireWorkspaceExecutionDirectory(input: {
  workspaceId?: string;
  workspaceDirectory: string | null | undefined;
}): string {
  const workspaceDirectory = resolveWorkspaceExecutionDirectory({
    workspaceDirectory: input.workspaceDirectory,
  });
  if (!workspaceDirectory) {
    throw new Error(
      input.workspaceId
        ? `Workspace directory is missing for workspace ${input.workspaceId}`
        : "Workspace directory is missing.",
    );
  }
  return workspaceDirectory;
}

export function resolveWorkspaceExecutionAuthority(
  input:
    | {
        workspace: WorkspaceDescriptor | null | undefined;
      }
    | {
        workspaces: Map<string, WorkspaceDescriptor> | undefined;
        workspaceId: string | null | undefined;
      },
): WorkspaceAuthorityResult | null {
  const result = getWorkspaceExecutionAuthority(input);
  return result.ok ? result.authority : null;
}
