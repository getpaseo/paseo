import { useMemo } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { buildPinAwareShortcutProjects, usePinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
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

  // Number shortcuts in the same order the sidebar shows them: pinned chats and
  // pinned projects float to the top, so their badges must too.
  const pinnedGroups = usePinnedSidebarGroups(projects);
  const orderedProjects = useMemo(
    () => buildPinAwareShortcutProjects(pinnedGroups),
    [pinnedGroups],
  );

  const shortcutModel = useMemo(
    () =>
      buildSidebarShortcutModel({
        projects: orderedProjects,
        collapsedProjectKeys,
      }),
    [collapsedProjectKeys, orderedProjects],
  );

  return {
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey: shortcutModel.shortcutIndexByWorkspaceKey,
    setProjectCollapsed,
    toggleProjectCollapsed,
  };
}
