import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { Columns2, Plus, Rows2, SquareTerminal, X } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { SortableInlineList } from "@/components/sortable-inline-list";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspaceTabLayout } from "@/screens/workspace/use-workspace-tab-layout";
import {
  useWorkspaceTabPresentation,
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import {
  buildWorkspaceDesktopTabActions,
  type WorkspaceDesktopTabActions,
} from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

const DROPDOWN_WIDTH = 220;
const LOADING_TAB_LABEL_SKELETON_WIDTH = 80;
type NewTabOptionId = "__new_tab_agent__";
type NewTabSelection = {
  optionId: NewTabOptionId;
  paneId?: string;
};

export interface WorkspaceDesktopTabRowItem {
  tab: WorkspaceTabDescriptor;
  isActive: boolean;
  isCloseHovered: boolean;
  isClosingTab: boolean;
}

type WorkspaceDesktopTabsRowProps = {
  paneId?: string;
  isFocused?: boolean;
  tabs: WorkspaceDesktopTabRowItem[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  setHoveredTabKey: Dispatch<SetStateAction<string | null>>;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  onSelectNewTabOption: (selection: NewTabSelection) => void;
  newTabAgentOptionId: NewTabOptionId;
  onReorderTabs: (nextTabs: WorkspaceTabDescriptor[]) => void;
  onNewTerminalTab: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  externalDndContext?: boolean;
  activeDragTabId?: string | null;
  tabDropPreviewIndex?: number | null;
};

function getFallbackTabLabel(tab: WorkspaceTabDescriptor): string {
  if (tab.target.kind === "draft") {
    return "New Agent";
  }
  if (tab.target.kind === "terminal") {
    return "Terminal";
  }
  if (tab.target.kind === "file") {
    return tab.target.path.split("/").filter(Boolean).pop() ?? tab.target.path;
  }
  return "Agent";
}

function TabChip({
  tab,
  isActive,
  isFocused,
  resolvedTabWidth,
  showLabel,
  showCloseButton,
  isCloseHovered,
  isClosingTab,
  presentation,
  tooltipLabel,
  resolvedTab,
  setHoveredTabKey,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  dragHandleProps,
}: {
  tab: WorkspaceTabDescriptor;
  isActive: boolean;
  isFocused: boolean;
  resolvedTabWidth: number;
  showLabel: boolean;
  showCloseButton: boolean;
  isCloseHovered: boolean;
  isClosingTab: boolean;
  presentation: WorkspaceTabPresentation;
  tooltipLabel: string;
  resolvedTab: WorkspaceDesktopTabActions;
  setHoveredTabKey: Dispatch<SetStateAction<string | null>>;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  dragHandleProps: any;
}) {
  const { theme } = useUnistyles();
  const { closeButtonTestId, contextMenuTestId, menuEntries } = resolvedTab;
  const [hovered, setHovered] = useState(false);
  const isHighlighted = isActive || hovered || isCloseHovered;

  return (
    <ContextMenu key={tab.key}>
      <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="triggerRef">
          <ContextMenuTrigger
            testID={`workspace-tab-${tab.key}`}
            enabledOnMobile={false}
            style={({ hovered, pressed }) => [
              styles.tab,
              {
                minWidth: resolvedTabWidth,
                width: resolvedTabWidth,
                maxWidth: resolvedTabWidth,
              },
            ]}
            onHoverIn={() => {
              setHovered(true);
              setHoveredTabKey(tab.key);
            }}
            onHoverOut={() => {
              setHovered(false);
              setHoveredTabKey((current) => (current === tab.key ? null : current));
            }}
            onPressIn={() => {
              onNavigateTab(tab.tabId);
            }}
            onPress={() => {
              onNavigateTab(tab.tabId);
            }}
            accessibilityLabel={tooltipLabel}
          >
            {isActive && (
              <View
                style={[
                  styles.tabFocusIndicator,
                  !isFocused && styles.tabFocusIndicatorUnfocused,
                ]}
              />
            )}
            <View
              {...(dragHandleProps?.attributes as any)}
              {...(dragHandleProps?.listeners as any)}
              ref={dragHandleProps?.setActivatorNodeRef}
              style={styles.tabHandle}
            >
              <View style={styles.tabIcon}>
                <WorkspaceTabIcon presentation={presentation} active={isHighlighted} />
              </View>
              {showLabel ? (
                presentation.titleState === "loading" ? (
                  <View
                    style={[
                      styles.tabLabelSkeleton,
                      showCloseButton && styles.tabLabelSkeletonWithCloseButton,
                    ]}
                  />
                ) : (
                  <Text
                    style={[
                      styles.tabLabel,
                      isHighlighted && styles.tabLabelActive,
                      showCloseButton && styles.tabLabelWithCloseButton,
                    ]}
                    selectable={false}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {presentation.label}
                  </Text>
                )
              ) : null}
            </View>

            {showCloseButton ? (
              <Pressable
                testID={closeButtonTestId}
                disabled={isClosingTab}
                onHoverIn={() => {
                  setHoveredTabKey(tab.key);
                  setHoveredCloseTabKey(tab.key);
                }}
                onHoverOut={() => {
                  setHoveredTabKey((current) => (current === tab.key ? null : current));
                  setHoveredCloseTabKey((current) => (current === tab.key ? null : current));
                }}
                onPress={(event) => {
                  event.stopPropagation?.();
                  void onCloseTab(tab.tabId);
                }}
                style={({ hovered, pressed }) => [
                  styles.tabCloseButton,
                  styles.tabCloseButtonShown,
                  (hovered || pressed) && styles.tabCloseButtonActive,
                ]}
              >
                {({ hovered, pressed }) =>
                  isClosingTab ? (
                    <ActivityIndicator
                      size={12}
                      color={hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
                    />
                  ) : (
                    <X
                      size={12}
                      color={hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
                    />
                  )
                }
              </Pressable>
            ) : null}
          </ContextMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={styles.newTabTooltipText}>{tooltipLabel}</Text>
        </TooltipContent>
      </Tooltip>

      <ContextMenuContent align="start" width={DROPDOWN_WIDTH} testID={contextMenuTestId}>
        {menuEntries.map((entry) =>
          entry.kind === "separator" ? (
            <ContextMenuSeparator key={entry.key} />
          ) : (
            <ContextMenuItem
              key={entry.key}
              testID={entry.testID}
              disabled={entry.disabled}
              destructive={entry.destructive}
              onSelect={entry.onSelect}
            >
              {entry.label}
            </ContextMenuItem>
          )
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function WorkspaceDesktopTabsRow({
  paneId,
  isFocused = false,
  tabs,
  normalizedServerId,
  normalizedWorkspaceId,
  setHoveredTabKey,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onSelectNewTabOption,
  newTabAgentOptionId,
  onReorderTabs,
  onNewTerminalTab,
  onSplitRight,
  onSplitDown,
  externalDndContext = false,
  activeDragTabId = null,
  tabDropPreviewIndex = null,
}: WorkspaceDesktopTabsRowProps) {
  const { theme } = useUnistyles();
  const [tabsContainerWidth, setTabsContainerWidth] = useState<number>(0);
  const [tabsActionsWidth, setTabsActionsWidth] = useState<number>(0);

  const handleTabsContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    setTabsContainerWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
  }, []);

  const handleTabsActionsLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    setTabsActionsWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
  }, []);

  const layoutMetrics = useMemo(
    () => ({
      rowHorizontalInset: 0,
      actionsReservedWidth: Math.max(0, tabsActionsWidth),
      rowPaddingHorizontal: 0,
      tabGap: 0,
      maxTabWidth: 200,
      tabIconWidth: 14,
      tabHorizontalPadding: theme.spacing[3],
      estimatedCharWidth: 7,
      closeButtonWidth: 22,
    }),
    [tabsActionsWidth, theme.spacing]
  );

  const tabLabelLengths = useMemo(
    () =>
      tabs.map((tab) => {
        const label = getFallbackTabLabel(tab.tab);
        return label.length;
      }),
    [tabs]
  );

  const { layout } = useWorkspaceTabLayout({
    tabLabelLengths,
    viewportWidthOverride: tabsContainerWidth > 0 ? tabsContainerWidth : null,
    metrics: layoutMetrics,
  });

  return (
    <View
      style={styles.tabsContainer}
      testID="workspace-tabs-row"
      onLayout={handleTabsContainerLayout}
    >
      <ScrollView
        horizontal
        scrollEnabled={layout.requiresHorizontalScrollFallback}
        testID="workspace-tabs-scroll"
        style={[
          styles.tabsScroll,
          layout.requiresHorizontalScrollFallback ? styles.tabsScrollOverflow : styles.tabsScrollFitContent,
        ]}
        contentContainerStyle={styles.tabsContent}
        showsHorizontalScrollIndicator={false}
      >
        <SortableInlineList
          data={tabs}
          keyExtractor={(tab) => `${tab.tab.key}:${tab.tab.kind}`}
          useDragHandle
          disabled={tabs.length < 2}
          onDragEnd={(nextTabs) => onReorderTabs(nextTabs.map((tab) => tab.tab))}
          externalDndContext={externalDndContext}
          activeId={activeDragTabId}
          getItemData={
            paneId
              ? (tab) => ({
                  kind: "workspace-tab",
                  paneId,
                  tabId: tab.tab.tabId,
                })
              : undefined
          }
          renderItem={({ item, index, dragHandleProps }) => {
            const shouldShowCloseButton = layout.closeButtonPolicy === "all";
            const layoutItem = layout.items[index] ?? null;
            const resolvedTabWidth = layoutItem?.width ?? 150;
            const showLabel = layoutItem?.showLabel ?? true;
            const showDropIndicatorBefore =
              activeDragTabId !== null && tabDropPreviewIndex === index;
            const showDropIndicatorAfter =
              activeDragTabId !== null &&
              tabDropPreviewIndex === tabs.length &&
              index === tabs.length - 1;

            return (
              <ResolvedDesktopTabChip
                key={`${item.tab.key}:${item.tab.kind}`}
                item={item}
                isFocused={isFocused}
                index={index}
                tabCount={tabs.length}
                normalizedServerId={normalizedServerId}
                normalizedWorkspaceId={normalizedWorkspaceId}
                onCopyResumeCommand={onCopyResumeCommand}
                onCopyAgentId={onCopyAgentId}
                onCloseTabsToLeft={onCloseTabsToLeft}
                onCloseTabsToRight={onCloseTabsToRight}
                onCloseOtherTabs={onCloseOtherTabs}
                resolvedTabWidth={resolvedTabWidth}
                showLabel={showLabel}
                showCloseButton={shouldShowCloseButton}
                setHoveredTabKey={setHoveredTabKey}
                setHoveredCloseTabKey={setHoveredCloseTabKey}
                onNavigateTab={onNavigateTab}
                onCloseTab={onCloseTab}
                dragHandleProps={dragHandleProps}
                showDropIndicatorBefore={showDropIndicatorBefore}
                showDropIndicatorAfter={showDropIndicatorAfter}
              />
            );
          }}
        />
      </ScrollView>
      <View style={styles.tabsActions} onLayout={handleTabsActionsLayout}>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
            testID="workspace-new-agent-tab"
            onPress={() =>
              onSelectNewTabOption({
                optionId: newTabAgentOptionId,
                paneId,
              })
            }
            accessibilityRole="button"
            accessibilityLabel="New agent tab"
            style={({ hovered, pressed }) => [
              styles.newTabActionButton,
              (hovered || pressed) && styles.newTabActionButtonHovered,
            ]}
          >
            <Plus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" offset={8}>
            <View style={styles.newTabTooltipRow}>
              <Text style={styles.newTabTooltipText}>New agent tab</Text>
              <Shortcut keys={["mod", "T"]} style={styles.newTabTooltipShortcut} />
            </View>
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger
            onPress={onNewTerminalTab}
            accessibilityRole="button"
            accessibilityLabel="New terminal tab"
            style={({ hovered, pressed }) => [
              styles.newTabActionButton,
              (hovered || pressed) && styles.newTabActionButtonHovered,
            ]}
          >
            <SquareTerminal size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" offset={8}>
            <Text style={styles.newTabTooltipText}>New terminal tab</Text>
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger
            onPress={onSplitRight}
            accessibilityRole="button"
            accessibilityLabel="Split pane right"
            style={({ hovered, pressed }) => [
              styles.newTabActionButton,
              (hovered || pressed) && styles.newTabActionButtonHovered,
            ]}
          >
            <Columns2 size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" offset={8}>
            <Text style={styles.newTabTooltipText}>Split pane right</Text>
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger
            onPress={onSplitDown}
            accessibilityRole="button"
            accessibilityLabel="Split pane down"
            style={({ hovered, pressed }) => [
              styles.newTabActionButton,
              (hovered || pressed) && styles.newTabActionButtonHovered,
            ]}
          >
            <Rows2 size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" offset={8}>
            <Text style={styles.newTabTooltipText}>Split pane down</Text>
          </TooltipContent>
        </Tooltip>
      </View>
    </View>
  );
}

function ResolvedDesktopTabChip({
  item,
  isFocused,
  index,
  tabCount,
  normalizedServerId,
  normalizedWorkspaceId,
  onCopyResumeCommand,
  onCopyAgentId,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  resolvedTabWidth,
  showLabel,
  showCloseButton,
  setHoveredTabKey,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  dragHandleProps,
  showDropIndicatorBefore,
  showDropIndicatorAfter,
}: {
  item: WorkspaceDesktopTabRowItem;
  isFocused: boolean;
  index: number;
  tabCount: number;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  resolvedTabWidth: number;
  showLabel: boolean;
  showCloseButton: boolean;
  setHoveredTabKey: Dispatch<SetStateAction<string | null>>;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  dragHandleProps: any;
  showDropIndicatorBefore: boolean;
  showDropIndicatorAfter: boolean;
}) {
  const presentation = useWorkspaceTabPresentation({
    tab: item.tab,
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
  });
  const tooltipLabel =
    presentation.titleState === "loading" ? "Loading agent title" : presentation.label;
  const resolvedTab = useMemo(
    () =>
      buildWorkspaceDesktopTabActions({
        tab: item.tab,
        index,
        tabCount,
        onCopyResumeCommand,
        onCopyAgentId,
        onCloseTab,
        onCloseTabsToLeft,
        onCloseTabsToRight,
        onCloseOtherTabs,
      }),
    [
      index,
      item.tab,
      onCloseOtherTabs,
      onCloseTab,
      onCloseTabsToLeft,
      onCloseTabsToRight,
      onCopyAgentId,
      onCopyResumeCommand,
      tabCount,
    ]
  );

  return (
    <View style={styles.tabSlot}>
      {showDropIndicatorBefore ? (
        <View style={[styles.tabDropIndicator, styles.tabDropIndicatorBefore]} />
      ) : null}
      <TabChip
        tab={item.tab}
        isActive={item.isActive}
        isFocused={isFocused}
        resolvedTabWidth={resolvedTabWidth}
        showLabel={showLabel}
        showCloseButton={showCloseButton}
        isCloseHovered={item.isCloseHovered}
        isClosingTab={item.isClosingTab}
        presentation={presentation}
        tooltipLabel={tooltipLabel}
        resolvedTab={resolvedTab}
        setHoveredTabKey={setHoveredTabKey}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        onNavigateTab={onNavigateTab}
        onCloseTab={onCloseTab}
        dragHandleProps={dragHandleProps}
      />
      {showDropIndicatorAfter ? (
        <View style={[styles.tabDropIndicator, styles.tabDropIndicatorAfter]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabsContainer: {
    minWidth: 0,
    height: theme.spacing[2] * 2 + theme.iconSize.sm + theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
    overflow: "visible",
  },
  tabsScroll: {
    minWidth: 0,
  },
  tabsScrollFitContent: {
    flex: 1,
  },
  tabsScrollOverflow: {
    flex: 1,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  tabsActions: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
  },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  tabSlot: {
    position: "relative",
    overflow: "visible",
  },
  tabHandle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
    userSelect: "none",
  },
  tabIcon: {
    flexShrink: 0,
  },
  tabFocusIndicator: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: theme.colors.accent,
  },
  tabFocusIndicatorUnfocused: {
    backgroundColor: theme.colors.borderAccent,
  },
  tabDropIndicator: {
    position: "absolute",
    top: theme.spacing[2],
    bottom: theme.spacing[2],
    width: 5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    zIndex: 10,
    pointerEvents: "none",
  },
  tabDropIndicatorBefore: {
    left: -3,
  },
  tabDropIndicatorAfter: {
    right: -3,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    userSelect: "none",
  },
  tabLabelSkeleton: {
    width: 96,
    maxWidth: "100%",
    flexShrink: 1,
    minWidth: 0,
    height: 10,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.9,
  },
  tabLabelSkeletonWithCloseButton: {
    width: LOADING_TAB_LABEL_SKELETON_WIDTH,
  },
  tabLabelWithCloseButton: {
    paddingRight: 0,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabCloseButton: {
    width: 18,
    height: 18,
    marginLeft: 0,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  tabCloseButtonShown: {
    opacity: 1,
  },
  tabCloseButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  newTabActionButton: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  newTabActionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  newTabTooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  newTabTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  newTabTooltipShortcut: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
  },
}));
