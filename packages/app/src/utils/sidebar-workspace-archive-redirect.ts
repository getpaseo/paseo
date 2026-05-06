import { router } from "expo-router";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";

export function redirectIfArchivingActiveWorkspace(input: {
  serverId: string;
  workspaceId: string;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
}): boolean {
  if (
    input.activeWorkspaceSelection?.serverId !== input.serverId ||
    input.activeWorkspaceSelection.workspaceId !== input.workspaceId
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
