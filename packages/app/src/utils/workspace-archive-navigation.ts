import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildHostRootRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import { resolveWorkspaceRouteId } from "@/utils/workspace-execution";

export function resolveWorkspaceArchiveRedirectWorkspaceId(input: {
  archivedWorkspaceId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
}): string | null {
  const archivedWorkspaceId = resolveWorkspaceRouteId({
    routeWorkspaceId: input.archivedWorkspaceId,
  });
  if (!archivedWorkspaceId) {
    return null;
  }

  const workspaces = Array.from(input.workspaces);
  const archivedWorkspace =
    workspaces.find((workspace) => workspace.id === archivedWorkspaceId) ?? null;
  if (!archivedWorkspace) {
    return null;
  }

  const sameProjectWorkspaces = workspaces.filter(
    (workspace) => workspace.projectId === archivedWorkspace.projectId,
  );
  const rootCheckoutWorkspace =
    sameProjectWorkspaces.find(
      (workspace) =>
        workspace.workspaceKind === "local_checkout" && workspace.id !== archivedWorkspace.id,
    ) ?? null;
  if (rootCheckoutWorkspace) {
    return rootCheckoutWorkspace.id;
  }

  const siblingWorkspace =
    sameProjectWorkspaces.find((workspace) => workspace.id !== archivedWorkspace.id) ?? null;
  return siblingWorkspace?.id ?? null;
}

export function buildWorkspaceArchiveRedirectRoute(input: {
  serverId: string;
  archivedWorkspaceId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
}) {
  const redirectWorkspaceId = resolveWorkspaceArchiveRedirectWorkspaceId({
    archivedWorkspaceId: input.archivedWorkspaceId,
    workspaces: input.workspaces,
  });

  if (!redirectWorkspaceId) {
    return buildHostRootRoute(input.serverId);
  }

  return buildHostWorkspaceRoute(input.serverId, redirectWorkspaceId);
}
