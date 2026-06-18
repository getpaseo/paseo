import { useEffect, useMemo } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";

export function useSidebarShortcutModel(input: {
  projects: SidebarProjectEntry[];
  isInitialLoad: boolean;
}) {
  const { projects, isInitialLoad } = input;
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

  useEffect(() => {
    if (isInitialLoad || projects.length === 0) {
      return;
    }

    const projectKeys = new Set(projects.map((project) => project.projectKey));
    for (const key of collapsedProjectKeys) {
      if (!projectKeys.has(key)) {
        setProjectCollapsed(key, false);
      }
    }
  }, [collapsedProjectKeys, isInitialLoad, projects, setProjectCollapsed]);

  return {
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey: shortcutModel.shortcutIndexByWorkspaceKey,
    setProjectCollapsed,
    toggleProjectCollapsed,
  };
}
