import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import {
  CopyX,
  ArrowLeftToLine,
  ArrowRightToLine,
  Columns2,
  Copy,
  RotateCw,
  Rows2,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { SortableInlineList } from "@/components/sortable-inline-list";
import { isNative, isWeb } from "@/constants/platform";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { useWorkspaceTabLayout } from "@/screens/workspace/use-workspace-tab-layout";
import {
  WorkspaceTabPresentationResolver,
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
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  onCreateDraftTab: (input: { paneId?: string }) => void;
  onCreateTerminalTab: (input: { paneId?: string }) => void;
  disableCreateTerminal?: boolean;
  isWaitingOnTerminalReadiness?: boolean;
  onReorderTabs: (nextTabs: WorkspaceTabDescriptor[]) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  externalDndContext?: boolean;
  activeDragTabId?: string | null;
  tabDropPreviewIndex?: number | null;
  showPaneSplitActions?: boolean;
};

function getFallbackTabLabel(tab: WorkspaceTabDescriptor): string {
  if (tab.target.kind === "draft") {
    return "New Agent";
  }
  if (tab.target.kind === "setup") {
    return "Setup";
  }
  if (tab.target.kind === "terminal") {
    return "Terminal";
  }
  if (tab.target.kind === "file") {
    return tab.target.path.split("/").filter(Boolean).pop() ?? tab.target.path;
  }
  return "Agent";
}

function useMiddleClickClose(onClose: () => void) {
  const ref = useRef<View>(null);

  useEffect(() => {
    if (isNative) return;
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;

    function handleAuxClick(event: MouseEvent) {
      if (event.button === 1) {
        event.preventDefault();
        onClose();
      }
    }

    node.addEventListener("auxclick", handleAuxClick);
    return () => node.removeEventListener("auxclick", handleAuxClick);
  }, [onClose]);

  return ref;
}

function TabChip({
  tab,
  isActive,
  isDragging,
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
  isDragging: boolean;
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
  const middleClickRef = useMiddleClickClose(
    useCallback(() => void onCloseTab(tab.tabId), [onCloseTab, tab.tabId]),
  );
  const [hovered, setHovered] = useState(false);
  const isHighlighted = isActive || hovered || isCloseHovered;
  const closeButtonDragBlockers = isWeb
    ? ({
        onPointerDown: (event: { stopPropagation?: () => void }) => {
          event.stopPropagation?.();
        },
        onMouseDown: (event: { stopPropagation?: () => void }) => {
          event.stopPropagation?.();
        },
      } as const)
    : undefined;

  return (
    <View ref={middleClickRef}>
      <ContextMenu key={tab.key}>
        <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="triggerRef">
            <ContextMenuTrigger
              {...(dragHandleProps?.attributes as any)}
              {...(dragHandleProps?.listeners as any)}
              testID={`workspace-tab-${tab.key}`}
              triggerRef={dragHandleProps?.setActivatorNodeRef as any}
              enabledOnMobile={false}
              style={({ hovered, pressed }) => [
                styles.tab,
                isWeb && isDragging && ({ cursor: "grabbing" } as const),
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
              accessibilityRole="button"
              accessibilityLabel={tooltipLabel}
              accessibilityState={{ selected: isActive }}
              aria-selected={isActive}
            >
              {isActive && (
                <View
                  style={[
                    styles.tabFocusIndicator,
                    !isFocused && styles.tabFocusIndicatorUnfocused,
                  ]}
                />
              )}
              <View style={styles.tabHandle}>
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
                  {...(closeButtonDragBlockers as any)}
                  testID={closeButtonTestId}
                  disabled={isClosingTab}
                  onPressIn={(event) => {
                    event.stopPropagation?.();
                  }}
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
                        color={
                          hovered || pressed
                            ? theme.colors.foreground
                            : theme.colors.foregroundMuted
                        }
                      />
                    ) : (
                      <X
                        size={12}
                        color={
                          hovered || pressed
                            ? theme.colors.foreground
                            : theme.colors.foregroundMuted
                        }
                      />
                    )
                  }
                </Pressable>
              ) : null}
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            {tab.target.kind === "agent" ? (
              <View style={styles.tooltipAgentRow}>
                <Text style={styles.newTabTooltipText}>{tooltipLabel}</Text>
                <Text style={styles.tooltipAgentId}>{tab.target.agentId.slice(0, 7)}</Text>
              </View>
            ) : (
              <Text style={styles.newTabTooltipText}>{tooltipLabel}</Text>
            )}
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
                tooltip={entry.tooltip}
                leading={(() => {
                  const iconColor = theme.colors.foregroundMuted;
                  switch (entry.icon) {
                    case "copy":
                      return <Copy size={16} color={iconColor} />;
                    case "rotate-cw":
                      return <RotateCw size={16} color={iconColor} />;
                    case "arrow-left-to-line":
                      return <ArrowLeftToLine size={16} color={iconColor} />;
                    case "arrow-right-to-line":
                      return <ArrowRightToLine size={16} color={iconColor} />;
                    case "copy-x":
                      return <CopyX size={16} color={iconColor} />;
                    case "x":
                      return <X size={16} color={iconColor} />;
                    default:
                      return undefined;
                  }
                })()}
                trailing={
                  entry.hint ? <Text style={styles.menuItemHint}>{entry.hint}</Text> : undefined
                }
              >
                {entry.label}
              </ContextMenuItem>
            ),
          )}
        </ContextMenuContent>
      </ContextMenu>
    </View>
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
  onReloadAgent,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateDraftTab,
  onCreateTerminalTab,
  disableCreateTerminal = false,
  isWaitingOnTerminalReadiness = false,
  onReorderTabs,
  onSplitRight,
  onSplitDown,
  externalDndContext = false,
  activeDragTabId = null,
  tabDropPreviewIndex = null,
  showPaneSplitActions = true,
}: WorkspaceDesktopTabsRowProps) {
  const { theme } = useUnistyles();
  const newTabKeys = useShortcutKeys("workspace-tab-new");
  const newTerminalKeys = useShortcutKeys("workspace-terminal-new");
  const splitRightKeys = useShortcutKeys("workspace-pane-split-right");
  const splitDownKeys = useShortcutKeys("workspace-pane-split-down");
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
    [tabsActionsWidth, theme.spacing],
  );

  const tabLabelLengths = useMemo(
    () =>
      tabs.map((tab) => {
        const label = getFallbackTabLabel(tab.tab);
        return label.length;
      }),
    [tabs],
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
          layout.requiresHorizontalScrollFallback
            ? styles.tabsScrollOverflow
            : styles.tabsScrollFitContent,
        ]}
        contentContainerStyle={styles.tabsContent}
        showsHorizontalScrollIndicator={false}
      >
        <SortableInlineList
          data={tabs}
          keyExtractor={(tab) => `${tab.tab.key}:${tab.tab.kind}`}
          useDragHandle
          disabled={!externalDndContext && tabs.length < 2}
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
          renderItem={({ item, index, dragHandleProps, isActive }) => {
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
                isDragging={isActive}
                index={index}
                tabCount={tabs.length}
                normalizedServerId={normalizedServerId}
                normalizedWorkspaceId={normalizedWorkspaceId}
                onCopyResumeCommand={onCopyResumeCommand}
                onCopyAgentId={onCopyAgentId}
                onReloadAgent={onReloadAgent}
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
            onPress={() => onCreateDraftTab({ paneId })}
            accessibilityRole="button"
            accessibilityLabel="New agent tab"
            style={({ hovered, pressed }) => [
              styles.newTabActionButton,
              (hovered || pressed) && styles.newTabActionButtonHovered,
            ]}
          >
            <SquarePen size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <View style={styles.newTabTooltipRow}>
              <Text style={styles.newTabTooltipText}>New agent tab</Text>
              {newTabKeys ? (
                <Shortcut chord={newTabKeys} style={styles.newTabTooltipShortcut} />
              ) : null}
            </View>
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger
            testID="workspace-new-terminal"
            onPress={() => onCreateTerminalTab({ paneId })}
            disabled={disableCreateTerminal || isWaitingOnTerminalReadiness}
            accessibilityRole="button"
            accessibilityLabel={
              isWaitingOnTerminalReadiness ? "Preparing terminal tab" : "New terminal tab"
            }
            style={({ hovered, pressed }) => [
              styles.newTabActionButton,
              (disableCreateTerminal || isWaitingOnTerminalReadiness) &&
                styles.newTabActionButtonDisabled,
              (hovered || pressed) && styles.newTabActionButtonHovered,
            ]}
          >
            <SquareTerminal size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <View style={styles.newTabTooltipRow}>
              <Text style={styles.newTabTooltipText}>
                {isWaitingOnTerminalReadiness ? "Preparing terminal..." : "New terminal tab"}
              </Text>
              {newTerminalKeys ? (
                <Shortcut chord={newTerminalKeys} style={styles.newTabTooltipShortcut} />
              ) : null}
            </View>
          </TooltipContent>
        </Tooltip>
        {showPaneSplitActions ? (
          <>
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
              <TooltipContent side="bottom" align="center" offset={8}>
                <View style={styles.newTabTooltipRow}>
                  <Text style={styles.newTabTooltipText}>Split pane right</Text>
                  {splitRightKeys ? (
                    <Shortcut chord={splitRightKeys} style={styles.newTabTooltipShortcut} />
                  ) : null}
                </View>
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
              <TooltipContent side="bottom" align="center" offset={8}>
                <View style={styles.newTabTooltipRow}>
                  <Text style={styles.newTabTooltipText}>Split pane down</Text>
                  {splitDownKeys ? (
                    <Shortcut chord={splitDownKeys} style={styles.newTabTooltipShortcut} />
                  ) : null}
                </View>
              </TooltipContent>
            </Tooltip>
          </>
        ) : null}
      </View>
    </View>
  );
}

function ResolvedDesktopTabChip({
  item,
  isFocused,
  isDragging,
  index,
  tabCount,
  normalizedServerId,
  normalizedWorkspaceId,
  onCopyResumeCommand,
  onCopyAgentId,
  onReloadAgent,
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
  isDragging: boolean;
  index: number;
  tabCount: number;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
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
  const resolvedTab = useMemo(
    () =>
      buildWorkspaceDesktopTabActions({
        tab: item.tab,
        index,
        tabCount,
        onCopyResumeCommand,
        onCopyAgentId,
        onReloadAgent,
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
      onReloadAgent,
      tabCount,
    ],
  );

  return (
    <WorkspaceTabPresentationResolver
      tab={item.tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {(presentation) => {
        const tooltipLabel =
          presentation.titleState === "loading" ? "Loading agent title" : presentation.label;

        return (
          <View style={styles.tabSlot}>
            {showDropIndicatorBefore ? (
              <View style={[styles.tabDropIndicator, styles.tabDropIndicatorBefore]} />
            ) : null}
            <TabChip
              tab={item.tab}
              isActive={item.isActive}
              isDragging={isDragging}
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
      }}
    </WorkspaceTabPresentationResolver>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabsContainer: {
    minWidth: 0,
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
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
  newTabActionButtonDisabled: {
    opacity: 0.5,
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
  tooltipAgentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipAgentId: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  menuItemHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
