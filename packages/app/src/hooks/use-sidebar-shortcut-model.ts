import { useEffect, useMemo } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { isSidebarProjectFlattened } from "@/utils/sidebar-project-row-model";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";

export function useSidebarShortcutModel(projects: SidebarProjectEntry[]) {
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
    const collapsibleProjectKeys = new Set(
      projects
        .filter((project) => !isSidebarProjectFlattened(project))
        .map((project) => project.projectKey),
    );
    for (const key of collapsedProjectKeys) {
      if (!collapsibleProjectKeys.has(key)) {
        setProjectCollapsed(key, false);
      }
    }
  }, [collapsedProjectKeys, projects, setProjectCollapsed]);

  return {
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey: shortcutModel.shortcutIndexByWorkspaceKey,
    setProjectCollapsed,
    toggleProjectCollapsed,
  };
}
