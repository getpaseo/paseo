import { useEffect, useMemo } from "react";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { buildAttentionWorkspaceTargets } from "@/utils/sidebar-shortcuts";

export function WorkspaceShortcutTargetsSubscriber({ enabled }: { enabled: boolean }) {
  const { shortcutModel, allProjects, workspaceEntriesByKey } = useSidebarModel();
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets,
  );
  const setAttentionWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setAttentionWorkspaceTargets,
  );
  const attentionTargets = useMemo(
    () => buildAttentionWorkspaceTargets({ projects: allProjects, workspaceEntriesByKey }),
    [allProjects, workspaceEntriesByKey],
  );

  useEffect(() => {
    if (!enabled) {
      setSidebarShortcutWorkspaceTargets([]);
      setAttentionWorkspaceTargets([]);
      return;
    }

    setSidebarShortcutWorkspaceTargets(shortcutModel.shortcutTargets);
    setAttentionWorkspaceTargets(attentionTargets);
  }, [
    attentionTargets,
    enabled,
    setAttentionWorkspaceTargets,
    setSidebarShortcutWorkspaceTargets,
    shortcutModel.shortcutTargets,
  ]);

  useEffect(() => {
    return () => {
      setSidebarShortcutWorkspaceTargets([]);
      setAttentionWorkspaceTargets([]);
    };
  }, [setAttentionWorkspaceTargets, setSidebarShortcutWorkspaceTargets]);

  return null;
}
