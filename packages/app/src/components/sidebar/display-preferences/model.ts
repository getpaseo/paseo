import { useCallback, useMemo } from "react";
import {
  useAppSettings,
  type SidebarWorkspaceTrailing,
  type WorkspaceTitleSource,
} from "@/hooks/use-settings";
import {
  useSidebarViewStore,
  type SidebarGroupMode,
  type SidebarSortMode,
  type SidebarWorkspaceSortMode,
  type SidebarEmptyProjectSortMode,
  type SidebarProjectVisibility,
  type SidebarLabelFilter,
} from "@/stores/sidebar-view-store";
import { DEFAULT_SIDEBAR_CHECKS_DISPLAY, type SidebarChecksDisplay } from "./checks-display";
import { DEFAULT_SIDEBAR_ROW_ITEMS, type SidebarRowItem, type SidebarRowItems } from "./row-items";

import {
  toggleSidebarTrailingItem,
  type SidebarTrailingChoice,
} from "../workspace-trailing/selection";

export interface SidebarDisplayPreferences {
  workspaceSorting: SidebarWorkspaceSortMode;
  setWorkspaceSorting: (mode: SidebarWorkspaceSortMode) => void;
  sorting: SidebarSortMode;
  setSorting: (mode: SidebarSortMode) => void;
  projectVisibility: SidebarProjectVisibility;
  setProjectVisibility: (visibility: SidebarProjectVisibility) => void;
  emptyProjectSorting: SidebarEmptyProjectSortMode;
  setEmptyProjectSorting: (mode: SidebarEmptyProjectSortMode) => void;
  groupEmptyProjects: boolean;
  setGroupEmptyProjects: (enabled: boolean) => void;
  grouping: SidebarGroupMode;
  setGrouping: (mode: SidebarGroupMode) => void;
  titleSource: WorkspaceTitleSource;
  setTitleSource: (source: WorkspaceTitleSource) => void;
  rowItems: SidebarRowItems;
  toggleRowItem: (item: SidebarRowItem) => void;
  checksDisplay: SidebarChecksDisplay;
  setChecksDisplay: (display: SidebarChecksDisplay) => void;
  trailing: SidebarWorkspaceTrailing;
  /** Each trailing item can be shown independently. */
  toggleTrailing: (choice: SidebarTrailingChoice) => void;
  hostFilters: readonly string[];
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  /** Raw stored selection. For anything the user sees, use the model's resolved list instead. */
  projectFilters: readonly string[];
  toggleProjectFilter: (viewKey: string) => void;
  clearProjectFilters: () => void;
  labelFilter: SidebarLabelFilter;
  toggleLabelFilter: (name: string) => void;
  clearLabelFilter: () => void;
}

/**
 * Every decision the sidebar's display-preferences menu can make, behind one interface.
 *
 * Grouping and host filters live in a local zustand store while the title source and row items
 * are synced app settings — a split that exists for good reasons (a filter is transient view
 * state; a preference follows you) and that the menu has no business knowing about. Callers ask
 * this for a value and set it; where it lands is this module's problem.
 */
export function useSidebarDisplayPreferences(): SidebarDisplayPreferences {
  const workspaceSorting = useSidebarViewStore((state) => state.workspaceSortMode);
  const setWorkspaceSorting = useSidebarViewStore((state) => state.setWorkspaceSortMode);
  const sorting = useSidebarViewStore((state) => state.sortMode);
  const setSorting = useSidebarViewStore((state) => state.setSortMode);
  const projectVisibility = useSidebarViewStore((state) => state.projectVisibility);
  const setProjectVisibility = useSidebarViewStore((state) => state.setProjectVisibility);
  const emptyProjectSorting = useSidebarViewStore((state) => state.emptyProjectSortMode);
  const setEmptyProjectSorting = useSidebarViewStore((state) => state.setEmptyProjectSortMode);
  const groupEmptyProjects = useSidebarViewStore((state) => state.groupEmptyProjects);
  const setGroupEmptyProjects = useSidebarViewStore((state) => state.setGroupEmptyProjects);
  const grouping = useSidebarViewStore((state) => state.groupMode);
  const setGrouping = useSidebarViewStore((state) => state.setGroupMode);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const toggleHostFilter = useSidebarViewStore((state) => state.toggleHostFilter);
  const clearHostFilters = useSidebarViewStore((state) => state.clearHostFilters);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const toggleProjectFilter = useSidebarViewStore((state) => state.toggleProjectFilter);
  const clearProjectFilters = useSidebarViewStore((state) => state.clearProjectFilters);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const toggleLabelFilter = useSidebarViewStore((state) => state.toggleLabelFilter);
  const clearLabelFilter = useSidebarViewStore((state) => state.clearLabelFilter);

  const {
    settings: {
      workspaceTitleSource,
      sidebarWorkspaceTrailing,
      sidebarRowItems,
      sidebarChecksDisplay,
    },
    updateSettings,
  } = useAppSettings();

  const setTitleSource = useCallback(
    (source: WorkspaceTitleSource) => {
      void updateSettings({ workspaceTitleSource: source });
    },
    [updateSettings],
  );

  const toggleRowItem = useCallback(
    (item: SidebarRowItem) => {
      void updateSettings({
        sidebarRowItems: { ...sidebarRowItems, [item]: !sidebarRowItems[item] },
      });
    },
    [updateSettings, sidebarRowItems],
  );

  const setChecksDisplay = useCallback(
    (display: SidebarChecksDisplay) => {
      void updateSettings({ sidebarChecksDisplay: display });
    },
    [updateSettings],
  );

  const toggleTrailing = useCallback(
    (choice: SidebarTrailingChoice) => {
      void updateSettings({
        sidebarWorkspaceTrailing: toggleSidebarTrailingItem({
          trailing: sidebarWorkspaceTrailing,
          choice,
        }),
      });
    },
    [updateSettings, sidebarWorkspaceTrailing],
  );

  return useMemo(
    () => ({
      workspaceSorting,
      setWorkspaceSorting,
      sorting,
      setSorting,
      projectVisibility,
      setProjectVisibility,
      emptyProjectSorting,
      setEmptyProjectSorting,
      groupEmptyProjects,
      setGroupEmptyProjects,
      grouping,
      setGrouping,
      titleSource: workspaceTitleSource,
      setTitleSource,
      rowItems: sidebarRowItems,
      toggleRowItem,
      checksDisplay: sidebarChecksDisplay,
      setChecksDisplay,
      trailing: sidebarWorkspaceTrailing,
      toggleTrailing,
      hostFilters,
      toggleHostFilter,
      clearHostFilters,
      projectFilters,
      toggleProjectFilter,
      clearProjectFilters,
      labelFilter,
      toggleLabelFilter,
      clearLabelFilter,
    }),
    [
      workspaceSorting,
      setWorkspaceSorting,
      sorting,
      setSorting,
      projectVisibility,
      setProjectVisibility,
      emptyProjectSorting,
      setEmptyProjectSorting,
      groupEmptyProjects,
      setGroupEmptyProjects,
      grouping,
      setGrouping,
      workspaceTitleSource,
      setTitleSource,
      sidebarRowItems,
      toggleRowItem,
      sidebarChecksDisplay,
      setChecksDisplay,
      sidebarWorkspaceTrailing,
      toggleTrailing,
      hostFilters,
      toggleHostFilter,
      clearHostFilters,
      projectFilters,
      toggleProjectFilter,
      clearProjectFilters,
      labelFilter,
      toggleLabelFilter,
      clearLabelFilter,
    ],
  );
}

/**
 * Just the row items, for the row renderers. They re-render per workspace, so they subscribe to
 * the one field they use rather than to every preference in the menu.
 */
export function useSidebarRowItems(): SidebarRowItems {
  const {
    settings: { sidebarRowItems },
  } = useAppSettings();
  return sidebarRowItems ?? DEFAULT_SIDEBAR_ROW_ITEMS;
}

/**
 * Everything the line under a workspace title needs to know, in one read. The two settings are
 * answered together by `selectMetaRowItems`, so asking for them separately would only mean two
 * subscriptions per row for one decision.
 */
export function useSidebarMetaPreferences(): {
  rowItems: SidebarRowItems;
  checksDisplay: SidebarChecksDisplay;
} {
  const {
    settings: { sidebarRowItems, sidebarChecksDisplay },
  } = useAppSettings();
  return useMemo(
    () => ({
      rowItems: sidebarRowItems ?? DEFAULT_SIDEBAR_ROW_ITEMS,
      checksDisplay: sidebarChecksDisplay ?? DEFAULT_SIDEBAR_CHECKS_DISPLAY,
    }),
    [sidebarRowItems, sidebarChecksDisplay],
  );
}
