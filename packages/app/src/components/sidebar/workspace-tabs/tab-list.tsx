import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { mapLayout } from "@/components/ui/control-geometry";
import { isNative as platformIsNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { queryClient } from "@/data/query-client";
import { useFilePanelOpenWithMenu } from "@/file-panels";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import { useWorkspaceTabActions } from "@/screens/workspace/use-workspace-tab-actions";
import {
  useWorkspaceTabRename,
  WorkspaceTabRenameModal,
} from "@/screens/workspace/use-workspace-tab-rename";
import { buildWorkspaceTabActionEntries } from "@/screens/workspace/workspace-tab-menu";
import { MobileTabTrailingAccessory } from "@/screens/workspace/workspace-tab-trailing-accessory";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import { density, densityIconBox } from "@/styles/density";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useIsSidebarWorkspaceTabsExpanded } from "./expansion";
import { hasSidebarWorkspaceTabsDisclosure } from "./model";
import { useSidebarWorkspaceTabs } from "./use-workspace-tabs";

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
  // The registry is filled by the workspace screen, and the sidebar can render first: a cold
  // load of /open-project or Settings with saved tabs would otherwise throw in the resolver.
  ensurePanelsRegistered();
  const { tabs, activeTabId } = useSidebarWorkspaceTabs(serverId, workspaceId);
  const tabActions = useWorkspaceTabActions(serverId);
  const rename = useSidebarWorkspaceTabRename(serverId, workspaceId);
  const menuActions = useMemo<SidebarWorkspaceTabMenuActions>(
    () => ({
      onCopyResumeCommand: tabActions.copyResumeCommand,
      onCopyAgentId: tabActions.copyAgentId,
      onCopyTerminalId: tabActions.copyTerminalId,
      onCopyFilePath: tabActions.copyFilePath,
      onReloadAgent: tabActions.reloadAgent,
      onRenameTab: rename.handleRenameTab,
    }),
    [tabActions, rename.handleRenameTab],
  );
  // The disclosure leaves with the second-to-last tab; the list goes with it, and comes back
  // expanded when a second tab opens again.
  if (!hasSidebarWorkspaceTabsDisclosure(tabs.length)) return null;

  return (
    <View
      style={inStatusGroup ? styles.listInStatusGroup : styles.list}
      testID={`sidebar-workspace-tabs-${workspaceKey}`}
    >
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
              menuActions={menuActions}
            />
          )}
        </WorkspaceTabPresentationResolver>
      ))}
      <WorkspaceTabRenameModal
        renamingTab={rename.renamingTab}
        onSubmit={rename.handleRenameModalSubmit}
        onClose={rename.handleRenameModalClose}
      />
    </View>
  );
}

type SidebarWorkspaceTabMenuActions = Omit<
  Parameters<typeof buildWorkspaceTabActionEntries>[0],
  "tab" | "menuTestIDBase" | "labels"
>;

/** Rename reads the terminal's current title from the list its tab's descriptor fetched. */
function useSidebarWorkspaceTabRename(serverId: string, workspaceId: string) {
  const client = useHostRuntimeClient(serverId);
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  const terminalsQueryKey = useMemo(
    () => buildTerminalsQueryKey(serverId, workspaceDirectory, workspaceId),
    [serverId, workspaceDirectory, workspaceId],
  );
  const getTerminals = useCallback(
    () => queryClient.getQueryData<ListTerminalsResponse["payload"]>(terminalsQueryKey),
    [terminalsQueryKey],
  );
  return useWorkspaceTabRename({
    client,
    normalizedServerId: serverId,
    queryClient,
    getTerminals,
    terminalsQueryKey,
  });
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
  menuActions,
}: {
  tab: WorkspaceTabDescriptor;
  presentation: WorkspaceTabPresentation;
  active: boolean;
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  menuActions: SidebarWorkspaceTabMenuActions;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(
    () => openWorkspaceTab({ serverId, workspaceId, tabId: tab.tabId }),
    [serverId, workspaceId, tab.tabId],
  );
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const label =
    presentation.titleState === "loading" ? t("workspace.tabs.loading") : presentation.label;
  const menuTestIDBase = `sidebar-workspace-tab-menu-${workspaceKey}-${tab.tabId}`;
  const menuEntries = useMemo(
    () => buildWorkspaceTabActionEntries({ ...menuActions, tab, menuTestIDBase }),
    [menuActions, tab, menuTestIDBase],
  );
  const openWith = useFilePanelOpenWithMenu(
    { serverId, workspaceId, tabId: tab.tabId },
    menuTestIDBase,
  );
  // Hover-revealed on pointer; touch has no hover, so the menu is always there. It hides by
  // opacity rather than unmounting, so an open menu keeps its trigger when the pointer leaves.
  const showMenu = isHovered || platformIsNative || isCompact;
  const emphasized = active || isHovered;
  return (
    <View
      style={isHovered ? styles.rowHovered : styles.row}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        style={styles.rowPress}
        highlightStyle={styles.rowPressed}
        onPress={handlePress}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityState={accessibilityState}
        aria-selected={active}
        accessibilityLabel={label}
        testID={`sidebar-workspace-tab-${workspaceKey}-${tab.tabId}`}
      >
        <View style={styles.iconSlot}>
          <WorkspaceTabIcon
            presentation={presentation}
            active={emphasized}
            backdrop={isHovered ? "surfaceSidebarHover" : "surfaceSidebar"}
          />
        </View>
        <Text numberOfLines={1} style={emphasized ? styles.labelEmphasized : styles.label}>
          {label}
        </Text>
        {presentation.modified ? (
          <View style={styles.modifiedDot} accessibilityLabel={t("workspace.tabs.modified")} />
        ) : null}
      </PressHighlight>
      {menuEntries.length > 0 ? (
        <View
          style={showMenu ? styles.menuSlot : styles.menuSlotHidden}
          pointerEvents={showMenu ? "auto" : "none"}
        >
          <MobileTabTrailingAccessory
            menuTestIDBase={menuTestIDBase}
            presentationLabel={label}
            menuEntries={menuEntries}
            openWith={openWith}
          />
        </View>
      ) : null}
    </View>
  );
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
    // `rowIndented` replaces the row's leading padding rather than adding to it: one step more.
    (rail) => rail + theme.spacing[2],
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
    // The hover fill reaches back past the rail by the press area's own padding, so the icon ink
    // stays on the title rail. The outer View only tracks hover (docs/hover.md).
    row: {
      position: "relative",
      flexDirection: "row",
      alignItems: "center",
      marginLeft: -theme.spacing[2],
      borderRadius: theme.borderRadius.lg,
    },
    rowHovered: {
      position: "relative",
      flexDirection: "row",
      alignItems: "center",
      marginLeft: -theme.spacing[2],
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.surfaceSidebarHover,
    },
    rowPress: {
      flex: 1,
      minWidth: 0,
      minHeight: density.tightRowHeight,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[2],
      borderRadius: theme.borderRadius.lg,
      userSelect: "none",
    },
    rowPressed: {
      backgroundColor: theme.colors.surface2,
    },
    menuSlot: {
      paddingRight: theme.spacing[1],
    },
    menuSlotHidden: {
      paddingRight: theme.spacing[1],
      opacity: 0,
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
  };
});
