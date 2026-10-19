import { useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { RetainedPanel } from "@/components/retained-panel";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import type { TabDropPreview } from "@/components/split-container-tab-drop-preview";
import { WorkspacePanelHost } from "@/screens/workspace/workspace-panel-host";
import { deriveWorkspacePaneState } from "@/screens/workspace/workspace-pane-state";
import {
  WorkspaceDesktopTabsRow,
  type WorkspaceDesktopTabRowItem,
  type WorkspaceDesktopTabsRowProps,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import type { WorkspacePaneContentModel } from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { SplitPane } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";

interface ExplorerSidebarDockProps extends Pick<
  WorkspaceDesktopTabsRowProps,
  | "setHoveredCloseTabKey"
  | "onCopyResumeCommand"
  | "onCopyAgentId"
  | "onCopyTerminalId"
  | "onCopyFilePath"
  | "onReloadAgent"
  | "onRenameTab"
  | "onRetitleAgent"
  | "onCreateNewTab"
  | "onExitFocusMode"
> {
  hoveredCloseTabKey: string | null;
  onCloseTabsToLeft: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  pane: SplitPane;
  uiTabs: WorkspaceTab[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isWorkspaceFocused: boolean;
  closingTabIds: Set<string>;
  activeDragTabId: string | null;
  tabDropPreview: TabDropPreview | null;
  onSelectTab: (paneId: string, tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onReorderTabsInPane: (paneId: string, tabIds: string[]) => void;
  buildPaneContentModel: (input: {
    paneId: string;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
  headerAction?: ReactNode;
}

/** A dock shell over the shared panel host. It owns no workspace-pane capabilities. */
export function ExplorerSidebarDock({
  pane,
  uiTabs,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  closingTabIds,
  activeDragTabId,
  tabDropPreview,
  onSelectTab,
  onCloseTab,
  onCreateNewTab,
  hoveredCloseTabKey,
  setHoveredCloseTabKey,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onRetitleAgent,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onExitFocusMode,
  onReorderTabsInPane,
  buildPaneContentModel,
  headerAction,
}: ExplorerSidebarDockProps) {
  const paneState = useMemo(() => deriveWorkspacePaneState({ pane, tabs: uiTabs }), [pane, uiTabs]);
  const tabs = useMemo(() => paneState.tabs.map((tab) => tab.descriptor), [paneState.tabs]);
  const activeTabId = paneState.activeTabId;
  const tabItems = useMemo<WorkspaceDesktopTabRowItem[]>(
    () =>
      tabs.map((tab) => ({
        tab,
        isActive: tab.tabId === activeTabId,
        isCloseHovered: hoveredCloseTabKey === tab.key,
        isClosingTab: closingTabIds.has(tab.tabId),
      })),
    [activeTabId, closingTabIds, hoveredCloseTabKey, tabs],
  );
  const handleSelectTab = useCallback(
    (tabId: string) => onSelectTab(pane.id, tabId),
    [onSelectTab, pane.id],
  );
  const handleReorderTabs = useCallback(
    (nextTabs: WorkspaceTabDescriptor[]) => {
      onReorderTabsInPane(
        pane.id,
        nextTabs.map((tab) => tab.tabId),
      );
    },
    [onReorderTabsInPane, pane.id],
  );

  const handleCloseTabsToLeft = useCallback(
    (tabId: string) => onCloseTabsToLeft(tabId, tabs),
    [onCloseTabsToLeft, tabs],
  );
  const handleCloseTabsToRight = useCallback(
    (tabId: string) => onCloseTabsToRight(tabId, tabs),
    [onCloseTabsToRight, tabs],
  );
  const handleCloseOtherTabs = useCallback(
    (tabId: string) => onCloseOtherTabs(tabId, tabs),
    [onCloseOtherTabs, tabs],
  );

  return (
    <RetainedPanel active>
      <WindowChromeRegion corners="top-right">
        <View style={styles.dock} testID="workspace-explorer-sidebar">
          <WindowChromeSafeArea placement="inline" style={styles.tabRail}>
            <TitlebarDragRegion />
            <View style={styles.tabRow}>
              <WorkspaceDesktopTabsRow
                host="explorer"
                launchPurpose="supporting"
                isFocused={isWorkspaceFocused}
                ownsKeyboardShortcuts={false}
                setHoveredCloseTabKey={setHoveredCloseTabKey}
                onCopyResumeCommand={onCopyResumeCommand}
                onCopyAgentId={onCopyAgentId}
                onCopyTerminalId={onCopyTerminalId}
                onCopyFilePath={onCopyFilePath}
                onReloadAgent={onReloadAgent}
                onRenameTab={onRenameTab}
                onRetitleAgent={onRetitleAgent}
                onCloseTabsToLeft={handleCloseTabsToLeft}
                onCloseTabsToRight={handleCloseTabsToRight}
                onCloseOtherTabs={handleCloseOtherTabs}
                focusModeEnabled={false}
                onExitFocusMode={onExitFocusMode}
                externalDndContext
                paneId={pane.id}
                tabs={tabItems}
                normalizedServerId={normalizedServerId}
                normalizedWorkspaceId={normalizedWorkspaceId}
                activeDragTabId={activeDragTabId}
                tabDropPreviewIndex={
                  tabDropPreview?.paneId === pane.id ? tabDropPreview.indicatorIndex : null
                }
                onNavigateTab={handleSelectTab}
                onCloseTab={onCloseTab}
                onCreateNewTab={onCreateNewTab}
                onReorderTabs={handleReorderTabs}
              />
            </View>
            {headerAction ? <View style={styles.headerAction}>{headerAction}</View> : null}
            <View pointerEvents="none" style={styles.tabRailDivider} />
          </WindowChromeSafeArea>
          <View style={styles.content}>
            <WorkspacePanelHost
              paneId={pane.id}
              tabs={tabs}
              activeTabId={activeTabId}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              isWorkspaceFocused={isWorkspaceFocused}
              isPaneFocused
              buildPaneContentModel={buildPaneContentModel}
            />
          </View>
        </View>
      </WindowChromeRegion>
    </RetainedPanel>
  );
}

const styles = StyleSheet.create((theme) => ({
  dock: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  tabRail: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  tabRow: {
    flex: 1,
    minWidth: 0,
  },
  headerAction: {
    marginRight: theme.spacing[1],
  },
  tabRailDivider: {
    position: "absolute",
    right: 0,
    bottom: 0,
    left: 0,
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
  },
  content: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
}));
