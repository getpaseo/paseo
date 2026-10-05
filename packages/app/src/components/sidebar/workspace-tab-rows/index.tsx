// The default import is load-bearing under vitest: the app's `jsx: "react-native"` tsconfig
// leaves esbuild on the classic transform, so a rendered `.tsx` needs React in module scope.
import React, { memo, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import type { SidebarWorkspaceLeadingWrapperProps } from "@/components/sidebar/sidebar-workspace-row-content";
import { useAppSettings } from "@/hooks/use-settings";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { Theme } from "@/styles/theme";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  EMPTY_WORKSPACE_TABS,
  selectWorkspaceTabRows,
  type SidebarTabRow,
  type SidebarWorkspaceTabs,
} from "./model";

const EMPTY_AGENTS: ReadonlyMap<string, Agent> = new Map();

interface WorkspaceIdentity {
  /** The sidebar's key for the row; the folder's open state is stored under it. */
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
}

/**
 * Desktop only. A compact layout already has the workspace header's tab switcher, and its sidebar
 * is a drawer that closes on every navigation, so a folder there would duplicate the switcher
 * behind an extra tap. The setting is kept rather than cleared, so widening the window restores it.
 */
export function useSidebarTabTierEnabled(): boolean {
  const {
    settings: { sidebarTabRows },
  } = useAppSettings();
  const isCompact = useIsCompactFormFactor();
  return sidebarTabRows === true && !isCompact;
}

/** The whole folder in one read, so a row with the setting off does no work at all. */
export function useWorkspaceTabRows(
  input: Omit<WorkspaceIdentity, "workspaceKey"> & { enabled: boolean },
): SidebarWorkspaceTabs {
  const layoutKey = input.enabled
    ? buildWorkspaceTabPersistenceKey({ serverId: input.serverId, workspaceId: input.workspaceId })
    : null;
  const layout = useWorkspaceLayoutStore((state) =>
    layoutKey ? state.layoutByWorkspace[layoutKey] : undefined,
  );
  const explorerSidebarPaneId = useWorkspaceLayoutStore((state) =>
    layoutKey && state.layoutByWorkspace[layoutKey]
      ? selectExplorerSidebarPaneId(state, layoutKey)
      : null,
  );
  const hiddenAgentIds = useWorkspaceLayoutStore((state) =>
    layoutKey ? state.hiddenAgentIdsByWorkspace[layoutKey] : undefined,
  );
  // One subscription to a structurally shared Map, not one per agent — the same shape
  // `useSidebarWorkspaceEntries` uses, and for the same reason.
  const agents = useSessionStore((state) =>
    input.enabled ? (state.sessions[input.serverId]?.agents ?? EMPTY_AGENTS) : EMPTY_AGENTS,
  );
  return useMemo(() => {
    if (!input.enabled) {
      return EMPTY_WORKSPACE_TABS;
    }
    return selectWorkspaceTabRows({
      layout,
      explorerSidebarPaneId,
      hiddenAgentIds,
      agents: agents.values(),
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    });
  }, [
    agents,
    explorerSidebarPaneId,
    hiddenAgentIds,
    input.enabled,
    input.serverId,
    input.workspaceId,
    layout,
  ]);
}

function useWorkspaceTabsExpanded(workspaceKey: string) {
  const expanded = useSidebarCollapsedSectionsStore((state) =>
    state.expandedTabWorkspaceKeys.has(workspaceKey),
  );
  const toggleExpanded = useSidebarCollapsedSectionsStore(
    (state) => state.toggleWorkspaceTabsExpanded,
  );
  const setExpanded = useSidebarCollapsedSectionsStore((state) => state.setWorkspaceTabsExpanded);
  const toggle = useCallback(() => toggleExpanded(workspaceKey), [toggleExpanded, workspaceKey]);
  return { expanded, toggle, setExpanded };
}

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The workspace row's leading slot, turned into the folder's disclosure while the row is hovered.
 *
 * It takes the status indicator's slot rather than a slot of its own: the chevron is only needed
 * when the pointer is already on the row, and a permanent column would push every workspace title
 * off the rail the project rows line up on. The slot is the same size either way, so the swap
 * leaves the row's geometry alone (docs/hover.md, failure mode 2). A workspace with no tabs keeps
 * its indicator — there is nothing to open.
 */
export function WorkspaceTabsDisclosure({
  workspaceKey,
  serverId,
  workspaceId,
  isHovered,
  children,
}: WorkspaceIdentity & { isHovered: boolean; children: ReactNode }): ReactNode {
  const { t } = useTranslation();
  const enabled = useSidebarTabTierEnabled();
  const { rows } = useWorkspaceTabRows({ serverId, workspaceId, enabled });
  const { expanded, toggle } = useWorkspaceTabsExpanded(workspaceKey);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

  if (!enabled || rows.length === 0 || !isHovered) {
    return children;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(
        expanded ? "sidebar.workspace.tabs.collapse" : "sidebar.workspace.tabs.expand",
      )}
      accessibilityState={accessibilityState}
      onPress={toggle}
      hitSlop={4}
      style={styles.disclosure}
      testID={`sidebar-workspace-tabs-disclosure-${workspaceKey}`}
    >
      <View style={expanded ? styles.chevronExpanded : undefined}>
        <ThemedChevronRight size={14} uniProps={mutedIconMapping} />
      </View>
    </Pressable>
  );
}

/** `WorkspaceTabsDisclosure` in the shape the workspace row's leading slot takes. */
export function WorkspaceTabsLeading({
  workspace,
  isHovered,
  children,
}: SidebarWorkspaceLeadingWrapperProps): ReactNode {
  return (
    <WorkspaceTabsDisclosure
      workspaceKey={workspace.workspaceKey}
      serverId={workspace.serverId}
      workspaceId={workspace.workspaceId}
      isHovered={isHovered}
    >
      {children}
    </WorkspaceTabsDisclosure>
  );
}

/**
 * The open tabs inside one workspace, rendered under its row as a folder.
 *
 * Renders nothing when the folder is closed or the workspace has no tabs. An empty state here
 * would put a row under every workspace that has never been opened, which is most of them on a
 * first run, and say nothing the absent rows do not already say.
 *
 * The workspace being viewed opens its folder when it is selected, so the tabs of the place you
 * are in are always one glance away; closing it again sticks until you next arrive there.
 */
export const WorkspaceTabRows = memo(function WorkspaceTabRows({
  workspaceKey,
  serverId,
  workspaceId,
  selected,
  enabled,
}: WorkspaceIdentity & { selected: boolean; enabled: boolean }) {
  const { rows, activeTabId } = useWorkspaceTabRows({ serverId, workspaceId, enabled });
  const { expanded, setExpanded } = useWorkspaceTabsExpanded(workspaceKey);

  useEffect(() => {
    if (enabled && selected) {
      setExpanded(workspaceKey, true);
    }
  }, [enabled, selected, setExpanded, workspaceKey]);

  if (!enabled || !expanded || rows.length === 0) {
    return null;
  }

  return (
    <View role="group" testID={`sidebar-workspace-tabs-${workspaceKey}`}>
      {rows.map((row) => (
        <TabRow
          key={row.key}
          row={row}
          serverId={serverId}
          workspaceId={workspaceId}
          active={selected && row.descriptor.tabId === activeTabId}
        />
      ))}
    </View>
  );
});

const TabRow = memo(function TabRow({
  row,
  serverId,
  workspaceId,
  active,
}: {
  row: SidebarTabRow;
  serverId: string;
  workspaceId: string;
  active: boolean;
}) {
  const focusTab = useWorkspaceLayoutStore((state) => state.focusTab);
  const handlePress = useCallback(() => {
    // Focus by id first: two tabs can share a target (the same file in two panes), and the
    // reveal below would otherwise pick whichever it finds first rather than the row pressed.
    if (row.inLayout) {
      const layoutKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      if (layoutKey) {
        focusTab(layoutKey, row.descriptor.tabId);
      }
    }
    navigateToWorkspace({ serverId, workspaceId, target: row.descriptor.target });
  }, [focusTab, row.descriptor.tabId, row.descriptor.target, row.inLayout, serverId, workspaceId]);

  return (
    <WorkspaceTabPresentationResolver
      tab={row.descriptor}
      serverId={serverId}
      workspaceId={workspaceId}
    >
      {(presentation) => (
        <TabRowButton
          presentation={presentation}
          active={active}
          onPress={handlePress}
          testID={`sidebar-tab-row-${row.key}`}
        />
      )}
    </WorkspaceTabPresentationResolver>
  );
});

function TabRowButton({
  presentation,
  active,
  onPress,
  testID,
}: {
  presentation: WorkspaceTabPresentation;
  active: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      active && styles.rowActive,
      hovered && !pressed && !active && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [active],
  );

  return (
    <Pressable
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={t("sidebar.workspace.tabs.open", { name: presentation.label })}
      aria-selected={active}
      onPress={onPress}
      style={rowStyle}
      testID={testID}
    >
      <WorkspaceTabIcon
        presentation={presentation}
        active={active}
        size={14}
        backdrop={active ? "surfaceSidebarHover" : "surfaceSidebar"}
      />
      <Text style={active ? styles.titleActive : styles.title} numberOfLines={1}>
        {presentation.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  disclosure: {
    width: theme.iconSize.md,
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  row: {
    minHeight: 28,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[3],
    // A second step in from the workspace row, so the folder reads as belonging to the row above
    // it rather than as another workspace. Padding rather than margin, for the reason
    // `rowIndented` gives: the hover fill has to keep spanning the group's full width.
    paddingLeft: theme.spacing[2] * 3,
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  titleActive: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
