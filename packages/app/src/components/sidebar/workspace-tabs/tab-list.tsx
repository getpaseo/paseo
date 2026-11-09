import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { mapLayout } from "@/components/ui/control-geometry";
import { isWeb } from "@/constants/platform";
import { density, densityIconBox } from "@/styles/density";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useIsSidebarWorkspaceTabsExpanded } from "./expansion";
import { selectSidebarWorkspaceTabs } from "./model";

interface SidebarWorkspaceTabsProps {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  /** Status-group rows indent from their header, so their tabs do too. */
  inStatusGroup?: boolean;
}

/** The open tabs of a workspace, under its sidebar row while the row is expanded. */
export function SidebarWorkspaceTabs(props: SidebarWorkspaceTabsProps) {
  const expanded = useIsSidebarWorkspaceTabsExpanded(props.workspaceKey);
  if (!expanded) return null;
  return <SidebarWorkspaceTabList {...props} />;
}

function SidebarWorkspaceTabList({
  serverId,
  workspaceId,
  workspaceKey,
  inStatusGroup = false,
}: SidebarWorkspaceTabsProps) {
  const { t } = useTranslation();
  const layoutKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const layout = useWorkspaceLayoutStore((state) =>
    layoutKey ? (state.layoutByWorkspace[layoutKey] ?? null) : null,
  );
  const explorerPaneId = useWorkspaceLayoutStore((state) =>
    layoutKey ? selectExplorerSidebarPaneId(state, layoutKey) : null,
  );
  const { tabs, activeTabId } = useMemo(
    () => selectSidebarWorkspaceTabs({ layout, explorerPaneId }),
    [layout, explorerPaneId],
  );
  const listStyle = inStatusGroup ? styles.listInStatusGroup : styles.list;

  if (tabs.length === 0) {
    return (
      <View style={listStyle} testID={`sidebar-workspace-tabs-${workspaceKey}`}>
        <Text style={styles.emptyText}>{t("sidebar.workspace.actions.noOpenTabs")}</Text>
      </View>
    );
  }

  return (
    <View style={listStyle} testID={`sidebar-workspace-tabs-${workspaceKey}`}>
      {tabs.map((tab) => (
        <WorkspaceTabPresentationResolver
          key={tab.key}
          tab={tab}
          serverId={serverId}
          workspaceId={workspaceId}
        >
          {(presentation) => (
            <SidebarWorkspaceTabRow
              tab={tab}
              presentation={presentation}
              active={tab.tabId === activeTabId}
              serverId={serverId}
              workspaceId={workspaceId}
              workspaceKey={workspaceKey}
            />
          )}
        </WorkspaceTabPresentationResolver>
      ))}
    </View>
  );
}

/**
 * Opens the workspace on this tab. The tab is revealed by id rather than passed as a navigation
 * target: a target re-resolves placement and can open a compact sheet beside the tab that is
 * already there, while the id names the very tab the row lists — the same reveal the compact
 * tab switcher makes. Revealing after navigating also picks the panel: the explorer for its own
 * tabs on compact, the workspace otherwise, which closes the mobile menu.
 */
function openWorkspaceTab(input: { serverId: string; workspaceId: string; tabId: string }): void {
  navigateToWorkspace({ serverId: input.serverId, workspaceId: input.workspaceId });
  const layoutKey = buildWorkspaceTabPersistenceKey(input);
  if (layoutKey) revealWorkspaceTab(layoutKey, input.tabId);
}

function SidebarWorkspaceTabRow({
  tab,
  presentation,
  active,
  serverId,
  workspaceId,
  workspaceKey,
}: {
  tab: WorkspaceTabDescriptor;
  presentation: WorkspaceTabPresentation;
  active: boolean;
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    () => openWorkspaceTab({ serverId, workspaceId, tabId: tab.tabId }),
    [serverId, workspaceId, tab.tabId],
  );
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const label =
    presentation.titleState === "loading" ? t("workspace.tabs.loading") : presentation.label;
  const renderContent = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => {
      const emphasized = active || hovered;
      return (
        <>
          <View style={styles.iconSlot}>
            <WorkspaceTabIcon
              presentation={presentation}
              active={emphasized}
              backdrop={hovered ? "surfaceSidebarHover" : "surfaceSidebar"}
            />
          </View>
          <Text numberOfLines={1} style={emphasized ? styles.labelEmphasized : styles.label}>
            {label}
          </Text>
          {presentation.modified ? (
            <View style={styles.modifiedDot} accessibilityLabel={t("workspace.tabs.modified")} />
          ) : null}
        </>
      );
    },
    [active, label, presentation, t],
  );
  return (
    <PressHighlight
      style={tabRowStyle}
      highlightStyle={styles.rowPressed}
      onPress={handlePress}
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityState={accessibilityState}
      aria-selected={active}
      accessibilityLabel={label}
      testID={`sidebar-workspace-tab-${workspaceKey}-${tab.tabId}`}
    >
      {renderContent}
    </PressHighlight>
  );
}

function tabRowStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, hovered && styles.rowHovered];
}

const ICON_SIZE = 14;

const styles = StyleSheet.create((theme) => {
  // The workspace row's leading padding, status slot and gap: tab icons start on the rail the
  // workspace title starts on.
  const titleRail = mapLayout(
    densityIconBox("md"),
    (statusSlot) => theme.spacing[2] + statusSlot + theme.spacing[2],
  );
  const statusGroupTitleRail = mapLayout(
    titleRail,
    (rail) => rail + theme.spacing[2] + theme.spacing[2],
  );
  return {
    list: {
      paddingLeft: titleRail,
      marginBottom: theme.spacing[1],
    },
    listInStatusGroup: {
      paddingLeft: statusGroupTitleRail,
      marginBottom: theme.spacing[1],
    },
    row: {
      minHeight: density.tightRowHeight,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[2],
      // The hover fill reaches back past the rail by the row's own padding, so the icon ink
      // stays on the title rail.
      marginLeft: -theme.spacing[2],
      borderRadius: theme.borderRadius.lg,
      userSelect: "none",
    },
    rowHovered: {
      backgroundColor: theme.colors.surfaceSidebarHover,
    },
    rowPressed: {
      backgroundColor: theme.colors.surface2,
    },
    iconSlot: {
      width: ICON_SIZE,
      alignItems: "center",
      justifyContent: "center",
    },
    label: {
      flex: 1,
      minWidth: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    labelEmphasized: {
      flex: 1,
      minWidth: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foreground,
    },
    modifiedDot: {
      width: 8,
      height: 8,
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.foregroundMuted,
    },
    emptyText: {
      paddingVertical: theme.spacing[1],
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
  };
});
