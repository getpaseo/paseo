import { useCallback } from "react";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { paneFindController } from "./pane-find-controller";

const PANE_FIND_ACTIONS: readonly KeyboardActionId[] = ["workspace.find.open"];

/**
 * Single global handler for `workspace.find.open` (Ctrl/Cmd+F). Routes the
 * action through the pane-find registry's focused pane instead of every
 * pane registering its own bespoke keyboard handler.
 */
export function useGlobalPaneFindAction() {
  const handle = useCallback(() => {
    const state = paneFindController.getActiveState();
    if (!state) return false;
    if (state.isOpen) {
      paneFindController.closeActive();
      return true;
    }
    return paneFindController.openActive();
  }, []);

  useKeyboardActionHandler({
    handlerId: "workspace-find-open-global",
    actions: PANE_FIND_ACTIONS,
    enabled: true,
    priority: 0,
    handle,
  });
}
