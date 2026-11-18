import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useFilePanelOpenWithMenu } from "@/file-panels";
import {
  buildWorkspaceTabMenuEntries,
  type WorkspaceTabMenuLabels,
} from "@/screens/workspace/workspace-tab-menu";
import { WorkspaceTabMenuEntryItems } from "@/screens/workspace/workspace-tab-trailing-accessory";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { WorkspaceCompactHeaderActions } from "@/screens/workspace/adaptive-workspace-chrome";

/** What a chip's long-press menu does; the same actions the tab switcher's menu takes. */
export interface CompactWorkspaceTabStripMenuActions {
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
}

interface CompactWorkspaceTabStripProps {
  tabs: WorkspaceTabDescriptor[];
  activeTabKey: string;
  serverId: string;
  workspaceId: string;
  onSelectTab: (key: string) => void;
  menuActions: CompactWorkspaceTabStripMenuActions;
  /** The pane's bulk closes, which act on the pane's own tab order. */
  paneActions: Pick<WorkspaceCompactHeaderActions, "closeAbove" | "closeBelow" | "closeOthers">;
}

/**
 * The workspace's tabs as a scrolling row of chips, for a header with a full-width control row
 * (a folded iPhone with its vertical bar off). The tab switcher beside it stays the overflow; a
 * long press on a chip opens the same tab menu the wide tab row and the switcher offer.
 */
export const CompactWorkspaceTabStrip = memo(function CompactWorkspaceTabStrip({
  tabs,
  activeTabKey,
  serverId,
  workspaceId,
  onSelectTab,
  menuActions,
  paneActions,
}: CompactWorkspaceTabStripProps) {
  const menuLabels = useWorkspaceTabMenuLabels();
  const { closeAbove, closeBelow, closeOthers } = paneActions;
  const chipMenuActions = useMemo<TabChipMenuActions>(
    () => ({
      ...menuActions,
      onCloseTabsBefore: closeAbove,
      onCloseTabsAfter: closeBelow,
      onCloseOtherTabs: closeOthers,
    }),
    [menuActions, closeAbove, closeBelow, closeOthers],
  );
  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef(new Map<string, { x: number; width: number }>());
  const viewportWidth = useRef(0);

  const revealActive = useCallback(() => {
    const frame = offsets.current.get(activeTabKey);
    if (!frame || viewportWidth.current === 0) return;
    const x = Math.max(0, frame.x + frame.width / 2 - viewportWidth.current / 2);
    scrollRef.current?.scrollTo({ x, animated: true });
  }, [activeTabKey]);

  useEffect(revealActive, [revealActive]);

  const handleViewportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportWidth.current = event.nativeEvent.layout.width;
      revealActive();
    },
    [revealActive],
  );
  const handleChipLayout = useCallback(
    (key: string, event: LayoutChangeEvent) => {
      const { x, width } = event.nativeEvent.layout;
      offsets.current.set(key, { x, width });
      if (key === activeTabKey) revealActive();
    },
    [activeTabKey, revealActive],
  );

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.viewport}
      contentContainerStyle={styles.content}
      onLayout={handleViewportLayout}
      testID="workspace-tab-strip"
    >
      {tabs.map((tab, index) => (
        <WorkspaceTabPresentationResolver
          key={tab.key}
          tab={tab}
          serverId={serverId}
          workspaceId={workspaceId}
        >
          {(presentation) => (
            <TabChip
              tab={tab}
              index={index}
              tabCount={tabs.length}
              serverId={serverId}
              workspaceId={workspaceId}
              presentation={presentation}
              active={tab.key === activeTabKey}
              onSelect={onSelectTab}
              onLayout={handleChipLayout}
              menuActions={chipMenuActions}
              menuLabels={menuLabels}
            />
          )}
        </WorkspaceTabPresentationResolver>
      ))}
    </ScrollView>
  );
});

interface TabChipMenuActions extends CompactWorkspaceTabStripMenuActions {
  onCloseTabsBefore: (tabId: string) => Promise<void> | void;
  onCloseTabsAfter: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
}

function useWorkspaceTabMenuLabels(): WorkspaceTabMenuLabels {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      copyResumeCommand: t("workspace.tabs.menu.copyResumeCommand"),
      copyAgentId: t("workspace.tabs.menu.copyAgentId"),
      copyTerminalId: t("workspace.tabs.menu.copyTerminalId"),
      copyFilePath: t("workspace.tabs.menu.copyFilePath"),
      rename: t("workspace.tabs.menu.rename"),
      closeAbove: t("workspace.tabs.menu.closeAbove"),
      closeBelow: t("workspace.tabs.menu.closeBelow"),
      closeLeft: t("workspace.tabs.menu.closeLeft"),
      closeRight: t("workspace.tabs.menu.closeRight"),
      closeOthers: t("workspace.tabs.menu.closeOthers"),
      reloadAgent: t("workspace.tabs.menu.reloadAgent"),
      reloadAgentTooltip: t("workspace.tabs.menu.reloadAgentTooltip"),
      close: t("workspace.tabs.menu.close"),
    }),
    [t],
  );
}

function TabChip({
  tab,
  index,
  tabCount,
  serverId,
  workspaceId,
  presentation,
  active,
  onSelect,
  onLayout,
  menuActions,
  menuLabels,
}: {
  tab: WorkspaceTabDescriptor;
  index: number;
  tabCount: number;
  serverId: string;
  workspaceId: string;
  presentation: WorkspaceTabPresentation;
  active: boolean;
  onSelect: (key: string) => void;
  onLayout: (key: string, event: LayoutChangeEvent) => void;
  menuActions: TabChipMenuActions;
  menuLabels: WorkspaceTabMenuLabels;
}) {
  const menuTestIDBase = `workspace-tab-strip-menu-${tab.tabId}`;
  // The strip runs left to right, so its menu closes tabs to the left and right.
  const menuEntries = useMemo(
    () =>
      buildWorkspaceTabMenuEntries({
        surface: "desktop",
        tab,
        index,
        tabCount,
        menuTestIDBase,
        ...menuActions,
        labels: menuLabels,
      }),
    [tab, index, tabCount, menuTestIDBase, menuActions, menuLabels],
  );
  const openWith = useFilePanelOpenWithMenu(
    { serverId, workspaceId, tabId: tab.tabId },
    menuTestIDBase,
  );
  const { key } = presentation;
  const handlePress = useCallback(() => onSelect(key), [onSelect, key]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onLayout(key, event),
    [onLayout, key],
  );
  const chipStyle = useMemo(() => [styles.chip, active && styles.chipActive], [active]);
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        accessibilityRole="tab"
        accessibilityLabel={presentation.label}
        accessibilityState={accessibilityState}
        onPress={handlePress}
        onLayout={handleLayout}
        style={chipStyle}
        highlightStyle={styles.chipPressed}
        testID={`workspace-tab-strip-${key}`}
      >
        <View style={styles.icon}>
          <WorkspaceTabIcon
            presentation={presentation}
            active={active}
            size={14}
            backdrop={active ? "surface2" : "surface0"}
          />
        </View>
        <Text numberOfLines={1} style={active ? styles.labelActive : styles.label}>
          {presentation.label}
        </Text>
      </ContextMenuTrigger>
      <ContextMenuContent
        align="start"
        width={220}
        sheetTitle={presentation.label}
        pages={openWith.pages}
        testID={menuTestIDBase}
      >
        <WorkspaceTabMenuEntryItems entries={menuEntries} openWith={openWith} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  viewport: {
    flex: 1,
    minWidth: 0,
  },
  content: {
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  chip: {
    height: 32,
    maxWidth: 180,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
  },
  chipActive: {
    backgroundColor: theme.colors.surface2,
  },
  chipPressed: {
    backgroundColor: theme.colors.surface1,
  },
  icon: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  label: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  labelActive: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
