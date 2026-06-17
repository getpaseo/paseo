import { useCallback } from "react";
import { router } from "expo-router";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { buildHostNewWorkspaceRoute } from "@/utils/host-routes";

const WORKSPACE_NEW_ACTIONS: readonly KeyboardActionId[] = ["workspace.new"];

export function useGlobalNewWorkspaceAction() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;

  const handle = useCallback(() => {
    if (!serverId) {
      return false;
    }
    router.navigate(buildHostNewWorkspaceRoute(serverId) as never);
    return true;
  }, [serverId]);

  useKeyboardActionHandler({
    handlerId: "workspace-new-global",
    actions: WORKSPACE_NEW_ACTIONS,
    enabled: serverId !== null,
    priority: 0,
    handle,
  });
}
