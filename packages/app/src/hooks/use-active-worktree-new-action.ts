import { useCallback } from "react";
import { router } from "expo-router";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { buildHostNewWorkspaceRoute } from "@/utils/host-routes";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";

const WORKTREE_NEW_ACTIONS: readonly KeyboardActionId[] = ["worktree.new"];

export function useActiveWorktreeNewAction() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;

  const workingDir = useSessionStore((state) => {
    if (!serverId || !workspaceId) {
      return null;
    }
    const workspace = state.sessions[serverId]?.workspaces?.get(workspaceId);
    if (!workspace || workspace.projectKind !== "git") {
      return null;
    }
    return workspace.projectRootPath;
  });

  const displayName = useSessionStore((state) => {
    if (!serverId || !workspaceId) {
      return null;
    }
    const workspace = state.sessions[serverId]?.workspaces?.get(workspaceId);
    if (!workspace || workspace.projectKind !== "git") {
      return null;
    }
    return workspace.projectDisplayName || projectDisplayNameFromProjectId(workspace.projectId);
  });

  const handle = useCallback(() => {
    if (!serverId || !workingDir) {
      return false;
    }
    router.navigate(
      buildHostNewWorkspaceRoute(serverId, workingDir, {
        displayName: displayName ?? undefined,
      }) as never,
    );
    return true;
  }, [serverId, workingDir, displayName]);

  useKeyboardActionHandler({
    handlerId: "worktree-new-active",
    actions: WORKTREE_NEW_ACTIONS,
    enabled: serverId !== null && workingDir !== null,
    priority: 0,
    handle,
  });
}
