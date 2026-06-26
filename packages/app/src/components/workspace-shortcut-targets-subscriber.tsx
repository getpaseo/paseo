import { useEffect, useMemo } from "react";
import { useSidebarWorkspacesList } from "@/hooks/use-sidebar-workspaces-list";
import { useStatusModeWorkspacePlacements } from "@/hooks/use-status-mode-workspaces";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  buildSidebarShortcutModel,
  buildStatusSidebarShortcutModel,
} from "@/utils/sidebar-shortcuts";

export function WorkspaceShortcutTargetsSubscriber({ enabled }: { enabled: boolean }) {
  const { workspacePlacements, projects, projectNamesByKey } = useSidebarWorkspacesList({
    enabled,
  });
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const isStatusMode = enabled && groupMode === "status";
  const statusWorkspacePlacements = useStatusModeWorkspacePlacements({
    placements: workspacePlacements,
    enabled: isStatusMode,
  });
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
        workspaces: statusWorkspacePlacements,
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
    statusWorkspacePlacements,
  ]);

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
