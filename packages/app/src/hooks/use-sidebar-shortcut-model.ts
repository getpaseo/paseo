import { useMemo } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";

export function useSidebarShortcutModel(input: { projects: SidebarProjectEntry[] }) {
  const { projects } = input;
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const setProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.setProjectCollapsed,
  );
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );

  const shortcutModel = useMemo(
    () =>
      buildSidebarShortcutModel({
        projects,
        collapsedProjectKeys,
      }),
    [collapsedProjectKeys, projects],
  );

  return {
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey: shortcutModel.shortcutIndexByWorkspaceKey,
    setProjectCollapsed,
    toggleProjectCollapsed,
  };
}
