import { useEffect, useMemo } from "react";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";

export function WorkspaceShortcutTargetsSubscriber({ enabled }: { enabled: boolean }) {
  const { shortcutModel, workspaceEntriesByKey, projectNamesByViewKey } = useSidebarModel();
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets,
  );
  const setReadyWaitingWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setReadyWaitingWorkspaceTargets,
  );
  const readyWaitingWorkspaceTargets = useMemo(() => {
    const statusGroups = buildStatusGroups(
      Array.from(workspaceEntriesByKey.values()),
      projectNamesByViewKey,
    );
    return statusGroups
      .filter((group) => group.bucket === "needs_input" || group.bucket === "attention")
      .flatMap((group) =>
        group.rows.map((workspace) => ({
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
        })),
      );
  }, [projectNamesByViewKey, workspaceEntriesByKey]);

  useEffect(() => {
    if (!enabled) {
      setSidebarShortcutWorkspaceTargets([]);
      setReadyWaitingWorkspaceTargets([]);
      return;
    }

    setSidebarShortcutWorkspaceTargets(shortcutModel.shortcutTargets);
    setReadyWaitingWorkspaceTargets(readyWaitingWorkspaceTargets);
  }, [
    enabled,
    readyWaitingWorkspaceTargets,
    setReadyWaitingWorkspaceTargets,
    setSidebarShortcutWorkspaceTargets,
    shortcutModel.shortcutTargets,
  ]);

  useEffect(() => {
    return () => {
      setSidebarShortcutWorkspaceTargets([]);
      setReadyWaitingWorkspaceTargets([]);
    };
  }, [setReadyWaitingWorkspaceTargets, setSidebarShortcutWorkspaceTargets]);

  return null;
}
