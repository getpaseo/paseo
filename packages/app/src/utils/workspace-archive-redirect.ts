import type { Href } from "expo-router";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";

export interface RedirectIfArchivingActiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
}

export interface RedirectIfArchivingActiveWorkspaceDeps {
  navigateToRoute: (route: Href) => void;
  readWorkspaces: (serverId: string) => Iterable<WorkspaceDescriptor>;
}

export function redirectIfArchivingActiveWorkspace(
  input: RedirectIfArchivingActiveWorkspaceInput,
  deps: RedirectIfArchivingActiveWorkspaceDeps,
): boolean {
  if (
    input.activeWorkspaceSelection?.serverId !== input.serverId ||
    input.activeWorkspaceSelection.workspaceId !== input.workspaceId
  ) {
    return false;
  }

  deps.navigateToRoute(
    buildWorkspaceArchiveRedirectRoute({
      serverId: input.serverId,
      archivedWorkspaceId: input.workspaceId,
      workspaces: deps.readWorkspaces(input.serverId),
    }),
  );
  return true;
}
