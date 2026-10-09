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
  navigateToWorkspace: (target: ActiveWorkspaceSelection) => void;
  readSidebarWorkspaceTargets: () => readonly ActiveWorkspaceSelection[];
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

  const targets = deps.readSidebarWorkspaceTargets();
  const currentIndex = targets.findIndex(
    (target) => target.serverId === input.serverId && target.workspaceId === input.workspaceId,
  );
  const candidates = [
    ...targets.slice(currentIndex + 1),
    ...targets.slice(0, Math.max(0, currentIndex)).toReversed(),
  ];
  const nextWorkspace = candidates.find((target) => {
    if (target.serverId === input.serverId && target.workspaceId === input.workspaceId) {
      return false;
    }
    return Array.from(deps.readWorkspaces(target.serverId)).some(
      (workspace) => workspace.id === target.workspaceId && workspace.archivingAt == null,
    );
  });
  if (nextWorkspace) {
    deps.navigateToWorkspace(nextWorkspace);
    return true;
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
