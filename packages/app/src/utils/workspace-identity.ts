import type { WorkspaceDescriptor } from "@/stores/session-store";

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeWorkspaceOpaqueId(value: string | null | undefined): string | null {
  return trimNonEmpty(value);
}

export function normalizeWorkspacePath(value: string | null | undefined): string | null {
  const trimmed = trimNonEmpty(value);
  if (!trimmed) {
    return null;
  }
  const withUnixSeparators = trimmed.replace(/\\/g, "/");
  if (withUnixSeparators === "/") {
    return withUnixSeparators;
  }
  const withoutTrailingSlash = withUnixSeparators.replace(/\/+$/, "");
  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : "/";
}

export function resolveWorkspaceRouteId(input: {
  routeWorkspaceId: string | null | undefined;
}): string | null {
  return normalizeWorkspaceOpaqueId(input.routeWorkspaceId);
}

// Single approved cwd→workspaceId inference site.
// Do not add cwd-to-id inference elsewhere; prefer agent.workspaceId when the daemon provides it.
export function resolveWorkspaceIdByDirectory(input: {
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
