import { useEffect, useMemo } from "react";
import {
  useProjectNamesMap,
  useStatusModeWorkspaceEntries,
} from "@/hooks/use-status-mode-workspaces";
import { useSidebarWorkspacesList } from "@/hooks/use-sidebar-workspaces-list";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  buildSidebarShortcutModel,
  buildStatusSidebarShortcutModel,
} from "@/utils/sidebar-shortcuts";

export function WorkspaceShortcutTargetsSubscriber({
  enabled,
  serverId,
}: {
  enabled: boolean;
  serverId: string | null;
}) {
  const { projects } = useSidebarWorkspacesList({ serverId, enabled });
  // groupMode must be resolved before gating the status-mode subscriptions below.
  const groupMode = useSidebarViewStore((state) =>
    enabled && serverId ? state.getGroupMode(serverId) : "project",
  );
  // Only subscribe to agents/workspaces when the status-group view is actually active.
  // In project mode (the default), these subscriptions would fire on every agent update
  // (agents Map identity is replaced on every status transition) with no effect on
  // the shortcut targets, causing ~15-46 wasted re-renders per agent switch.
  const isStatusMode = enabled && groupMode === "status";
  const statusWorkspaces = useStatusModeWorkspaceEntries({
    serverId: isStatusMode ? serverId : null,
    projects,
  });
  const projectNamesByKey = useProjectNamesMap(isStatusMode ? serverId : null);
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedStatusGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedStatusGroupKeys,
  );
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets,
  );

  const shortcutModel = useMemo(() => {
    if (groupMode === "status") {
      return buildStatusSidebarShortcutModel({
        workspaces: statusWorkspaces,
        projectNamesByKey,
        collapsedStatusGroupKeys,
      });
    }

    return buildSidebarShortcutModel({
      projects,
      collapsedProjectKeys,
    });
  }, [
    collapsedProjectKeys,
    collapsedStatusGroupKeys,
    groupMode,
    projectNamesByKey,
    projects,
    statusWorkspaces,
  ]);

  useEffect(() => {
    if (!enabled || !serverId) {
      setSidebarShortcutWorkspaceTargets([]);
      return;
    }

    setSidebarShortcutWorkspaceTargets(shortcutModel.shortcutTargets);
  }, [enabled, serverId, setSidebarShortcutWorkspaceTargets, shortcutModel.shortcutTargets]);

  useEffect(() => {
    return () => {
      setSidebarShortcutWorkspaceTargets([]);
    };
  }, [setSidebarShortcutWorkspaceTargets]);

  return null;
}
