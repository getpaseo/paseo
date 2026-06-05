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
  const statusWorkspaces = useStatusModeWorkspaceEntries({
    serverId: enabled ? serverId : null,
    projects,
  });
  const projectNamesByKey = useProjectNamesMap(enabled ? serverId : null);
  const groupMode = useSidebarViewStore((state) =>
    enabled && serverId ? state.getGroupMode(serverId) : "project",
  );
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
