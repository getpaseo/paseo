import { useMemo } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { resolveCollapsedProjectKeys } from "@/stores/sidebar-collapsed-sections-store/state";

export function useSidebarShortcutModel(input: { projects: SidebarProjectEntry[] }) {
  const { projects } = input;
  const expandedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.expandedProjectKeys,
  );
  const setProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.setProjectCollapsed,
  );
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );

  const collapsedProjectKeys = useMemo(
    () =>
      resolveCollapsedProjectKeys(
        projects.map((project) => project.projectKey),
        expandedProjectKeys,
      ),
    [expandedProjectKeys, projects],
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
