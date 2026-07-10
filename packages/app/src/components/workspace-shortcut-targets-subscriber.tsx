import { useEffect } from "react";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";

export function WorkspaceShortcutTargetsSubscriber({ enabled }: { enabled: boolean }) {
  const { shortcutModel } = useSidebarModel();
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets,
  );

  useEffect(() => {
    if (!enabled) {
      setSidebarShortcutWorkspaceTargets([]);
      return;
    }

    setSidebarShortcutWorkspaceTargets(shortcutModel.shortcutTargets);
  }, [enabled, setSidebarShortcutWorkspaceTargets, shortcutModel.shortcutTargets]);

  useEffect(() => {
    return () => {
      setSidebarShortcutWorkspaceTargets([]);
    };
  }, [setSidebarShortcutWorkspaceTargets]);

  return null;
}
