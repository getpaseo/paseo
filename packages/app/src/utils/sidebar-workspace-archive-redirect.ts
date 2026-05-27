import { router } from "expo-router";
import { useSessionStore } from "@/stores/session-store";
import {
  redirectIfArchivingActiveWorkspace as redirectIfArchivingActiveWorkspacePure,
  type RedirectIfArchivingActiveWorkspaceInput,
} from "@/utils/sidebar-workspace-archive-redirect.pure";

export function redirectIfArchivingActiveWorkspace(
  input: RedirectIfArchivingActiveWorkspaceInput,
): boolean {
  return redirectIfArchivingActiveWorkspacePure(input, {
    navigateToRoute: (route) => router.replace(route),
    readWorkspaces: (serverId) =>
      useSessionStore.getState().sessions[serverId]?.workspaces.values() ?? [],
  });
}
