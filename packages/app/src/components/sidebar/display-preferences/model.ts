import { useCallback, useMemo } from "react";
import {
  useAppSettings,
  type SidebarWorkspaceTrailing,
  type WorkspaceTitleSource,
} from "@/hooks/use-settings";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import { DEFAULT_SIDEBAR_CHECKS_DISPLAY, type SidebarChecksDisplay } from "./checks-display";
import { DEFAULT_SIDEBAR_ROW_ITEMS, type SidebarRowItem, type SidebarRowItems } from "./row-items";
import { DEFAULT_SIDEBAR_STATUS_SUBTITLE, type SidebarStatusSubtitle } from "./workspace-subtitle";

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
  statusSubtitle: SidebarStatusSubtitle;
  setStatusSubtitle: (value: SidebarStatusSubtitle) => void;
  identityIcon: boolean;
  setIdentityIcon: (value: boolean) => void;
  trailing: SidebarWorkspaceTrailing;
  /** Picking the choice that is already showing clears the slot. */
  toggleTrailing: (choice: SidebarTrailingChoice) => void;
  hostFilters: readonly string[];
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
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

  const {
    settings: {
      workspaceTitleSource,
      sidebarWorkspaceTrailing,
      sidebarRowItems,
      sidebarChecksDisplay,
      sidebarStatusSubtitle,
      sidebarIdentityIcon,
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

  const setStatusSubtitle = useCallback(
    (value: SidebarStatusSubtitle) => {
      void updateSettings({ sidebarStatusSubtitle: value });
    },
    [updateSettings],
  );

  const setIdentityIcon = useCallback(
    (value: boolean) => {
      void updateSettings({ sidebarIdentityIcon: value });
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
      statusSubtitle: sidebarStatusSubtitle,
      setStatusSubtitle,
      identityIcon: sidebarIdentityIcon,
      setIdentityIcon,
      trailing: sidebarWorkspaceTrailing,
      toggleTrailing,
      hostFilters,
      toggleHostFilter,
      clearHostFilters,
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
      sidebarStatusSubtitle,
      setStatusSubtitle,
      sidebarIdentityIcon,
      setIdentityIcon,
      sidebarWorkspaceTrailing,
      toggleTrailing,
      hostFilters,
      toggleHostFilter,
      clearHostFilters,
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
  statusSubtitle: SidebarStatusSubtitle;
  identityIcon: boolean;
} {
  const {
    settings: { sidebarRowItems, sidebarChecksDisplay, sidebarStatusSubtitle, sidebarIdentityIcon },
  } = useAppSettings();
  return useMemo(
    () => ({
      rowItems: sidebarRowItems ?? DEFAULT_SIDEBAR_ROW_ITEMS,
      checksDisplay: sidebarChecksDisplay ?? DEFAULT_SIDEBAR_CHECKS_DISPLAY,
      statusSubtitle: sidebarStatusSubtitle ?? DEFAULT_SIDEBAR_STATUS_SUBTITLE,
      identityIcon: sidebarIdentityIcon ?? true,
    }),
    [sidebarRowItems, sidebarChecksDisplay, sidebarStatusSubtitle, sidebarIdentityIcon],
  );
}
