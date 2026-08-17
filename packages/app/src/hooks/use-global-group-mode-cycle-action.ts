import { useCallback } from "react";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { nextGroupMode, useSidebarViewStore } from "@/stores/sidebar-view-store";

const GROUP_MODE_CYCLE_ACTIONS: readonly KeyboardActionId[] = ["sidebar.cycle.group-mode"];

/**
 * Registers the global handler for the "Cycle sidebar grouping" shortcut.
 * Steps the sidebar group mode through its cycle (project -> status -> ...).
 * The binding lives in SHORTCUT_BINDINGS (Cmd+Shift+G on macOS, Ctrl+Shift+G
 * elsewhere) and is rebindable in Settings. Mounted once at the app root, like
 * useGlobalNewWorkspaceAction.
 */
export function useGlobalGroupModeCycleAction() {
  const handle = useCallback(() => {
    const { groupMode, setGroupMode } = useSidebarViewStore.getState();
    setGroupMode(nextGroupMode(groupMode));
    return true;
  }, []);

  useKeyboardActionHandler({
    handlerId: "group-mode-cycle-global",
    actions: GROUP_MODE_CYCLE_ACTIONS,
    enabled: true,
    priority: 0,
    handle,
  });
}
