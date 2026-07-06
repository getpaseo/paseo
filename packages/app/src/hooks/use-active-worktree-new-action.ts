import { useCallback } from "react";
import { router } from "expo-router";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

const WORKTREE_NEW_ACTIONS: readonly KeyboardActionId[] = ["worktree.new"];

export function useActiveWorktreeNewAction() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(serverId, workspaceId);
  const activeGitWorkspace = activeWorkspace?.projectKind === "git" ? activeWorkspace : null;

  const handle = useCallback(() => {
    if (!serverId || !activeGitWorkspace) {
      return false;
    }
    router.navigate(
      buildNewWorkspaceRoute({
        serverId,
        sourceDirectory: activeGitWorkspace.projectRootPath,
        projectId: activeGitWorkspace.projectId,
      }) as never,
    );
    return true;
  }, [activeGitWorkspace, serverId]);

  useKeyboardActionHandler({
    handlerId: "worktree-new-active",
    actions: WORKTREE_NEW_ACTIONS,
    enabled: serverId !== null && activeGitWorkspace !== null,
    priority: 0,
    handle,
  });
}
