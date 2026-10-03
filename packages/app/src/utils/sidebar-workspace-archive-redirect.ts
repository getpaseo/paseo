import { router } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSessionStore } from "@/stores/session-store";
import {
  redirectIfArchivingActiveWorkspace as redirectIfArchivingActiveWorkspacePure,
  type RedirectIfArchivingActiveWorkspaceInput,
} from "@/utils/workspace-archive-redirect";

export function redirectIfArchivingActiveWorkspace(
  input: RedirectIfArchivingActiveWorkspaceInput,
): boolean {
  return redirectIfArchivingActiveWorkspacePure(input, {
    navigateToWorkspace,
    readSidebarWorkspaceTargets: () => useKeyboardShortcutsStore.getState().sidebarWorkspaceTargets,
    navigateToRoute: (route) => router.replace(route),
    readWorkspaces: (serverId) =>
      useSessionStore.getState().sessions[serverId]?.workspaces.values() ?? [],
  });
}
