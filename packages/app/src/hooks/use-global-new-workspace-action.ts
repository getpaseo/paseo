import { useCallback } from "react";
import { router } from "expo-router";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

const WORKSPACE_NEW_ACTIONS: readonly KeyboardActionId[] = ["workspace.new"];

export function useGlobalNewWorkspaceAction() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const hosts = useHosts();
  const activeWorkspace = useWorkspace(serverId, workspaceId);

  const handle = useCallback(() => {
    if (hosts.length === 0) {
      return false;
    }
    router.navigate(
      (serverId && activeWorkspace
        ? buildNewWorkspaceRoute({
            serverId,
            sourceDirectory: activeWorkspace.projectRootPath,
            projectId: activeWorkspace.projectId,
          })
        : buildNewWorkspaceRoute()) as never,
    );
    return true;
  }, [activeWorkspace, hosts.length, serverId]);

  useKeyboardActionHandler({
    handlerId: "workspace-new-global",
    actions: WORKSPACE_NEW_ACTIONS,
    enabled: hosts.length > 0,
    priority: 0,
    handle,
  });
}
