import { router } from "expo-router";
import { getNavigationActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";

export function redirectIfArchivingActiveWorkspace(input: {
  serverId: string;
  workspaceId: string;
}): boolean {
  const activeWorkspaceSelection = getNavigationActiveWorkspaceSelection();
  if (
    activeWorkspaceSelection?.serverId !== input.serverId ||
    activeWorkspaceSelection.workspaceId !== input.workspaceId
  ) {
    return false;
  }

  router.replace(
    buildWorkspaceArchiveRedirectRoute({
      serverId: input.serverId,
      archivedWorkspaceId: input.workspaceId,
      workspaces: useSessionStore.getState().sessions[input.serverId]?.workspaces.values() ?? [],
    }),
  );
  return true;
}
