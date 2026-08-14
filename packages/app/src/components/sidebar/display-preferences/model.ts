import { useCallback, useMemo } from "react";
import {
  useAppSettings,
  type SidebarWorkspaceTrailing,
  type WorkspaceTitleSource,
} from "@/hooks/use-settings";
import {
  useSidebarViewStore,
  type SidebarGroupMode,
  type SidebarLabelFilter,
  type SidebarLabelMatch,
} from "@/stores/sidebar-view-store";
import { DEFAULT_SIDEBAR_CHECKS_DISPLAY, type SidebarChecksDisplay } from "./checks-display";
import { DEFAULT_SIDEBAR_ROW_ITEMS, type SidebarRowItem, type SidebarRowItems } from "./row-items";

/** The trailing slot holds one thing, so these are a choice rather than toggles. */
export type SidebarTrailingChoice = Exclude<SidebarWorkspaceTrailing, "none">;

export interface SidebarDisplayPreferences {
  grouping: SidebarGroupMode;
  setGrouping: (mode: SidebarGroupMode) => void;
  titleSource: WorkspaceTitleSource;
  setTitleSource: (source: WorkspaceTitleSource) => void;
  rowItems: SidebarRowItems;
  toggleRowItem: (item: SidebarRowItem) => void;
  checksDisplay: SidebarChecksDisplay;
  setChecksDisplay: (display: SidebarChecksDisplay) => void;
  trailing: SidebarWorkspaceTrailing;
  /** Picking the choice that is already showing clears the slot. */
  toggleTrailing: (choice: SidebarTrailingChoice) => void;
  hostFilters: readonly string[];
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  labelFilter: SidebarLabelFilter;
  cycleLabelFilter: (name: string) => void;
  setLabelMatch: (match: SidebarLabelMatch) => void;
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
  const grouping = useSidebarViewStore((state) => state.groupMode);
  const setGrouping = useSidebarViewStore((state) => state.setGroupMode);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const toggleHostFilter = useSidebarViewStore((state) => state.toggleHostFilter);
  const clearHostFilters = useSidebarViewStore((state) => state.clearHostFilters);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const cycleLabelFilter = useSidebarViewStore((state) => state.cycleLabelFilter);
  const setLabelMatch = useSidebarViewStore((state) => state.setLabelMatch);
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
        sidebarWorkspaceTrailing: sidebarWorkspaceTrailing === choice ? "none" : choice,
      });
    },
    [updateSettings, sidebarWorkspaceTrailing],
  );

  return useMemo(
    () => ({
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
      labelFilter,
      cycleLabelFilter,
      setLabelMatch,
      clearLabelFilter,
    }),
    [
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
      labelFilter,
      cycleLabelFilter,
      setLabelMatch,
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
