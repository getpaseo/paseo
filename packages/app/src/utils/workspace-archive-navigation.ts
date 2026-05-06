import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildHostNewWorkspaceRoute, buildHostRootRoute } from "@/utils/host-routes";
import { resolveWorkspaceRouteId } from "@/utils/workspace-execution";

export function buildWorkspaceArchiveRedirectRoute(input: {
  serverId: string;
  archivedWorkspaceId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
}) {
  const archivedWorkspaceId = resolveWorkspaceRouteId({
    routeWorkspaceId: input.archivedWorkspaceId,
  });
  if (!archivedWorkspaceId) {
    return buildHostRootRoute(input.serverId);
  }

  const archivedWorkspace =
    Array.from(input.workspaces).find((workspace) => workspace.id === archivedWorkspaceId) ?? null;
  const sourceDirectory =
    archivedWorkspace?.projectRootPath || archivedWorkspace?.workspaceDirectory;
  if (!sourceDirectory) {
    return buildHostRootRoute(input.serverId);
  }

  return buildHostNewWorkspaceRoute(input.serverId, sourceDirectory, {
    displayName: archivedWorkspace.projectDisplayName,
  });
}
