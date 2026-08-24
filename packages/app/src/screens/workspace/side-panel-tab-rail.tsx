import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Check, type LucideIcon } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SortableInlineList } from "@/components/sortable-inline-list";
import type {
  DraggableListDragHandleProps,
  DraggableRenderItemInfo,
} from "@/components/draggable-list.types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceDesktopTabRowItem } from "@/screens/workspace/workspace-desktop-tabs-row";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  useWorkspaceTabLaunchCatalog,
  type WorkspaceTabLaunchItem,
} from "@/workspace-tabs/launcher";
import type { Theme } from "@/styles/theme";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";

const TAB_HITBOX_WIDTH = 32;
const TAB_ICON_SIZE = 16;
const TAB_GAP = 4;
const TAB_DROP_INDICATOR_WIDTH = 4;
const SIDE_PANEL_CONFIGURABLE_KINDS = new Set<WorkspaceTabDescriptor["target"]["kind"]>([
  "files",
  "changes_tree",
  "pull_request",
  "terminal",
]);

const ThemedCheck = withUnistyles(Check);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SidePanelTabRailProps {
  paneId: string;
  tabs: WorkspaceDesktopTabRowItem[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  isFocused: boolean;
  activeDragTabId: string | null;
  tabDropPreviewIndex: number | null;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onReorderTabs: (tabs: WorkspaceTabDescriptor[]) => void;
}

function tabKey(item: WorkspaceDesktopTabRowItem): string {
  return `${item.tab.key}:${item.tab.kind}`;
}

function resolveSidePanelTabBackdrop(active: boolean, hovered: boolean): SurfaceBackdrop {
  if (active) return "surfaceSidebarSelected";
  return hovered ? "surfaceSidebarHover" : "surfaceSidebar";
}

function SidePanelTab({
  item,
  isFocused,
  isDragging,
  dragHandleProps,
  onNavigateTab,
  normalizedServerId,
  normalizedWorkspaceId,
}: {
  item: WorkspaceDesktopTabRowItem;
  isFocused: boolean;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  onNavigateTab: (tabId: string) => void;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}) {
  const [hovered, setHovered] = useState(false);
  const handlePress = useCallback(
    () => onNavigateTab(item.tab.tabId),
    [item.tab.tabId, onNavigateTab],
  );
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const accessibilityState = useMemo(() => ({ selected: item.isActive }), [item.isActive]);
  const renderPresentation = useCallback(
    (presentation: WorkspaceTabPresentation) => (
      <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <Pressable
            {...(dragHandleProps?.attributes as object | undefined)}
            {...(dragHandleProps?.listeners as object | undefined)}
            ref={dragHandleProps?.setActivatorNodeRef as never}
            testID={`side-panel-tab-${item.tab.tabId}`}
            accessibilityRole="button"
            accessibilityLabel={presentation.tooltip}
            accessibilityState={accessibilityState}
            onPress={handlePress}
            onHoverIn={handleHoverIn}
            onHoverOut={handleHoverOut}
            style={[
              styles.tab,
              item.isActive && isFocused ? styles.tabActive : null,
              item.isActive && !isFocused ? styles.tabActiveUnfocused : null,
              hovered ? styles.tabHovered : null,
              isDragging ? styles.tabDragging : null,
            ]}
          >
            <WorkspaceTabIcon
              presentation={presentation}
              active={(item.isActive && isFocused) || hovered}
              size={TAB_ICON_SIZE}
              backdrop={resolveSidePanelTabBackdrop(item.isActive && isFocused, hovered)}
            />
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={styles.tooltipText}>{presentation.tooltip}</Text>
        </TooltipContent>
      </Tooltip>
    ),
    [
      accessibilityState,
      dragHandleProps,
      handleHoverIn,
      handleHoverOut,
      handlePress,
      hovered,
      isDragging,
      isFocused,
      item,
    ],
  );

  return (
    <WorkspaceTabPresentationResolver
      tab={item.tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {renderPresentation}
    </WorkspaceTabPresentationResolver>
  );
}

function CatalogIcon({ Icon, color = "" }: { Icon: LucideIcon; color?: string }) {
  return <Icon size={14} color={color} />;
}

const ThemedCatalogIcon = withUnistyles(CatalogIcon);

function SidePanelConfigurationItem({
  item,
  paneId,
}: {
  item: WorkspaceTabLaunchItem;
  paneId: string;
}) {
  const leading = useMemo(() => {
    return item.Icon ? <ThemedCatalogIcon Icon={item.Icon} uniProps={mutedColorMapping} /> : null;
  }, [item.Icon]);
  const handleSelect = useCallback(() => item.launch({ kind: "open", paneId }), [item, paneId]);

  return (
    <ContextMenuItem leading={leading} disabled={item.disabled} onSelect={handleSelect}>
      {item.label}
    </ContextMenuItem>
  );
}

function CurrentSidePanelTabConfigurationItem({
  tab,
  serverId,
  workspaceId,
  onCloseTab,
}: {
  tab: WorkspaceTabDescriptor;
  serverId: string;
  workspaceId: string;
  onCloseTab: (tabId: string) => Promise<void> | void;
}) {
  const leading = useMemo(() => <ThemedCheck size={14} uniProps={mutedColorMapping} />, []);
  const handleSelect = useCallback(() => void onCloseTab(tab.tabId), [onCloseTab, tab.tabId]);
  return (
    <WorkspaceTabPresentationResolver tab={tab} serverId={serverId} workspaceId={workspaceId}>
      {(presentation) => (
        <ContextMenuItem leading={leading} onSelect={handleSelect}>
          {presentation.label}
        </ContextMenuItem>
      )}
    </WorkspaceTabPresentationResolver>
  );
}

function catalogItemMatchesTab(item: WorkspaceTabLaunchItem, tab: WorkspaceTabDescriptor): boolean {
  if (item.panelKind !== tab.target.kind) return false;
  if (item.panelKind !== "plugin" || tab.target.kind !== "plugin") return true;
  return item.id === `plugin:${tab.target.pluginId}:${tab.target.panelId}`;
}

export function SidePanelTabRail({
  paneId,
  tabs,
  normalizedServerId,
  normalizedWorkspaceId,
  isFocused,
  activeDragTabId,
  tabDropPreviewIndex,
  onNavigateTab,
  onCloseTab,
  onReorderTabs,
}: SidePanelTabRailProps) {
  const groups = useWorkspaceTabLaunchCatalog({
    serverId: normalizedServerId,
    purpose: "supporting",
    host: "explorer",
  });
  const configurationItems = useMemo(
    () =>
      (groups.find((group) => group.id === "tabs")?.items ?? []).filter((item) =>
        SIDE_PANEL_CONFIGURABLE_KINDS.has(item.panelKind),
      ),
    [groups],
  );
  const handleDragEnd = useCallback(
    (nextTabs: WorkspaceDesktopTabRowItem[]) => onReorderTabs(nextTabs.map((item) => item.tab)),
    [onReorderTabs],
  );
  const getTabDragData = useCallback(
    (item: WorkspaceDesktopTabRowItem) => ({
      kind: "workspace-tab" as const,
      paneId,
      tabId: item.tab.tabId,
    }),
    [paneId],
  );
  const renderTab = useCallback(
    ({
      item,
      index,
      dragHandleProps,
      isActive,
    }: DraggableRenderItemInfo<WorkspaceDesktopTabRowItem>) => {
      const showBefore = activeDragTabId !== null && tabDropPreviewIndex === index;
      const showAfter =
        activeDragTabId !== null &&
        tabDropPreviewIndex === tabs.length &&
        index === tabs.length - 1;
      return (
        <View style={styles.tabSlot}>
          {showBefore ? <View style={[styles.dropIndicator, styles.dropIndicatorBefore]} /> : null}
          <SidePanelTab
            item={item}
            isFocused={isFocused}
            isDragging={isActive}
            dragHandleProps={dragHandleProps}
            onNavigateTab={onNavigateTab}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
          />
          {showAfter ? <View style={[styles.dropIndicator, styles.dropIndicatorAfter]} /> : null}
        </View>
      );
    },
    [
      activeDragTabId,
      isFocused,
      normalizedServerId,
      normalizedWorkspaceId,
      onNavigateTab,
      tabDropPreviewIndex,
      tabs.length,
    ],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger style={styles.track} testID="side-panel-tab-rail">
        <SortableInlineList
          data={tabs}
          keyExtractor={tabKey}
          renderItem={renderTab}
          onDragEnd={handleDragEnd}
          useDragHandle
          externalDndContext
          activeId={activeDragTabId}
          getItemData={getTabDragData}
        />
      </ContextMenuTrigger>
      <ContextMenuContent align="start" minWidth={200} testID="side-panel-tab-configuration">
        {tabs.map(({ tab }) => (
          <CurrentSidePanelTabConfigurationItem
            key={tab.tabId}
            tab={tab}
            serverId={normalizedServerId}
            workspaceId={normalizedWorkspaceId}
            onCloseTab={onCloseTab}
          />
        ))}
        {tabs.length > 0 ? <ContextMenuSeparator /> : null}
        {configurationItems
          .filter((item) => !tabs.some(({ tab }) => catalogItemMatchesTab(item, tab)))
          .map((item) => (
            <SidePanelConfigurationItem key={item.id} item={item} paneId={paneId} />
          ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    minWidth: 0,
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  tabSlot: {
    position: "relative",
    marginHorizontal: TAB_GAP / 2,
  },
  tab: {
    width: TAB_HITBOX_WIDTH,
    height: buttonControlHeight.xs,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    userSelect: "none",
  },
  tabActive: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
  },
  tabActiveUnfocused: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tabHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tabDragging: {
    opacity: 0.3,
  },
  dropIndicator: {
    position: "absolute",
    top: theme.spacing[0.5],
    bottom: theme.spacing[0.5],
    width: TAB_DROP_INDICATOR_WIDTH,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    zIndex: 10,
    pointerEvents: "none",
  },
  dropIndicatorBefore: {
    left: -TAB_GAP / 2 - TAB_DROP_INDICATOR_WIDTH / 2,
  },
  dropIndicatorAfter: {
    right: -TAB_GAP / 2 - TAB_DROP_INDICATOR_WIDTH / 2,
  },
  tooltipText: {
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.base,
  },
}));
