import { useCallback, useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useWorkspaceTabDrag } from "@/components/workspace-tab-drag-context";
import { StyleSheet } from "react-native-unistyles";
import { RetainedPanel } from "@/components/retained-panel";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import {
  ExplorerSplitBottomHeader,
  ExplorerSplitButton,
  ExplorerSplitDividerHandle,
} from "@/screens/workspace/explorer-split-controls";
import { useExplorerSplit } from "@/screens/workspace/use-explorer-split";
import { WorkspacePanelHost } from "@/screens/workspace/workspace-panel-host";
import { deriveWorkspacePaneState } from "@/screens/workspace/workspace-pane-state";
import {
  WorkspaceDesktopTabsRow,
  type WorkspaceDesktopTabRowItem,
  type WorkspaceDesktopTabsRowProps,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import type { WorkspacePaneContentModel } from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabExplorerSplitActions } from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { SplitPane, WorkspaceLayoutMode } from "@/stores/workspace-layout-store";
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
  | "onCreateNewTab"
  | "onExitFocusMode"
> {
  hoveredCloseTabKey: string | null;
  onCloseTabsToLeft: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string, tabs: WorkspaceTabDescriptor[]) => Promise<void> | void;
  pane: SplitPane;
  /** `buildWorkspaceTabPersistenceKey` for this workspace; keys the saved split. */
  workspaceKey: string;
  layoutMode: WorkspaceLayoutMode;
  uiTabs: WorkspaceTab[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isWorkspaceFocused: boolean;
  paneFocusSuspended: boolean;
  closingTabIds: Set<string>;
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
  workspaceKey,
  layoutMode,
  uiTabs,
  normalizedServerId,
  normalizedWorkspaceId,
  isWorkspaceFocused,
  paneFocusSuspended,
  closingTabIds,
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
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onExitFocusMode,
  onReorderTabsInPane,
  buildPaneContentModel,
  headerAction,
}: ExplorerSidebarDockProps) {
  const { activeDragTabId, tabDropPreview, externalDndContext } = useWorkspaceTabDrag();
  const paneState = useMemo(() => deriveWorkspacePaneState({ pane, tabs: uiTabs }), [pane, uiTabs]);
  const tabs = useMemo(() => paneState.tabs.map((tab) => tab.descriptor), [paneState.tabs]);
  const activeTabId = paneState.activeTabId;
  const split = useExplorerSplit({ workspaceKey, layoutMode, tabs, activeTabId });
  const { activateTopHalf } = split;
  const handleSelectTab = useCallback(
    (tabId: string) => {
      activateTopHalf();
      onSelectTab(pane.id, tabId);
    },
    [activateTopHalf, onSelectTab, pane.id],
  );
  const { t } = useTranslation();
  const showBelowLabel = t("workspace.tabs.explorerSidebar.showBelow");
  const unsplitLabel = t("workspace.tabs.explorerSidebar.unsplit");
  const lowerTabId = split.lowerTab?.tabId ?? null;
  const { canShowBelow, isSplit, showBelow, unsplit } = split;
  // Kept apart from hover state so each tab's menu keeps its actions while close buttons are hovered.
  const explorerSplitByTabId = useMemo(
    () =>
      new Map<string, WorkspaceTabExplorerSplitActions>(
        tabs.map((tab) => [
          tab.tabId,
          {
            canShowBelow: canShowBelow(tab),
            isSplit,
            showBelowLabel,
            unsplitLabel,
            onShowBelow: () => showBelow(tab),
            onUnsplit: unsplit,
          },
        ]),
      ),
    [canShowBelow, isSplit, showBelow, showBelowLabel, tabs, unsplit, unsplitLabel],
  );
  const tabItems = useMemo<WorkspaceDesktopTabRowItem[]>(
    () =>
      tabs.map((tab) => ({
        tab,
        isActive: tab.tabId === activeTabId,
        isCloseHovered: hoveredCloseTabKey === tab.key,
        isClosingTab: closingTabIds.has(tab.tabId),
        isShownBelow: tab.tabId === lowerTabId,
        explorerSplit: explorerSplitByTabId.get(tab.tabId),
      })),
    [activeTabId, closingTabIds, explorerSplitByTabId, hoveredCloseTabKey, lowerTabId, tabs],
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
                onCloseTabsToLeft={handleCloseTabsToLeft}
                onCloseTabsToRight={handleCloseTabsToRight}
                onCloseOtherTabs={handleCloseOtherTabs}
                focusModeEnabled={false}
                onExitFocusMode={onExitFocusMode}
                externalDndContext={externalDndContext}
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
            {layoutMode === "split-panes" ? (
              <View style={styles.headerAction}>
                <ExplorerSplitButton
                  canSplit={split.canSplit}
                  isSplit={split.isSplit}
                  onPress={split.toggle}
                />
              </View>
            ) : null}
            {headerAction ? <View style={styles.headerAction}>{headerAction}</View> : null}
            <View pointerEvents="none" style={styles.tabRailDivider} />
          </WindowChromeSafeArea>
          <View ref={split.contentRef} style={styles.content} onLayout={split.onContentLayout}>
            <WorkspacePanelHost
              paneId={pane.id}
              tabs={tabs}
              activeTabId={split.hostActiveTabId}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              isWorkspaceFocused={isWorkspaceFocused}
              isPaneFocused={!paneFocusSuspended}
              buildPaneContentModel={buildPaneContentModel}
              split={split.hostSplit}
            />
            {split.divider && split.lowerTab ? (
              <ExplorerSplitBottomHeader
                tab={split.lowerTab}
                top={split.divider.top}
                serverId={normalizedServerId}
                workspaceId={normalizedWorkspaceId}
                onUnsplit={split.unsplit}
              />
            ) : null}
            {split.divider ? <ExplorerSplitDividerHandle divider={split.divider} /> : null}
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
