import { useCallback, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ArrowLeftToLine, Ellipsis, Plus, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import Animated from "react-native-reanimated";
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
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { titlebarDragSurfaceStyle } from "@/components/desktop/titlebar-drag-region";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { iconButtonChromeGlyphSize } from "@/components/ui/icon-button-chrome";
import { HEADER_CONTROL_HEIGHT } from "@/components/ui/control-geometry";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import {
  buildExplorerSidebarConfigurationEntries,
  EXPLORER_SIDEBAR_CONFIGURATION_TRIGGER,
  type ExplorerSidebarConfigurationEntry,
} from "@/screens/workspace/explorer-sidebar-tab-configuration";
import type { WorkspaceDesktopTabRowItem } from "@/screens/workspace/workspace-desktop-tabs-row";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useWorkspaceTabLaunchCatalog } from "@/workspace-tabs/launcher";
import { panelSupportsHost } from "@/panels/panel-manifest";
import type { PanelIconProps } from "@/panels/panel-registry";
import { panelTargetSupportsHost } from "@/plugins/workspace-panels/locations";
import type { Theme } from "@/styles/theme";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import {
  HorizontalScrollBoundaryShades,
  useHorizontalScrollBoundary,
} from "@/components/ui/horizontal-scroll-boundary";

const TAB_GAP = 4;
const TAB_DROP_INDICATOR_WIDTH = 4;

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ExplorerSidebarTabRailProps {
  paneId: string;
  tabs: WorkspaceDesktopTabRowItem[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  activeDragTabId: string | null;
  tabDropPreviewIndex: number | null;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCreateNewTab: () => void;
  onMoveTabToMain: (tabId: string) => void;
  onReorderTabs: (tabs: WorkspaceTabDescriptor[]) => void;
  trailingAccessory?: ReactNode;
}

function tabKey(item: WorkspaceDesktopTabRowItem): string {
  return `${item.tab.key}:${item.tab.kind}`;
}

function resolveExplorerSidebarTabBackdrop(): SurfaceBackdrop {
  return "surfaceSidebar";
}

function ExplorerSidebarTab({
  item,
  isDragging,
  dragHandleProps,
  onNavigateTab,
  onCloseTab,
  onMoveTabToMain,
  normalizedServerId,
  normalizedWorkspaceId,
}: {
  item: WorkspaceDesktopTabRowItem;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onMoveTabToMain: (tabId: string) => void;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handlePress = useCallback(
    () => onNavigateTab(item.tab.tabId),
    [item.tab.tabId, onNavigateTab],
  );
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const handleClose = useCallback(() => {
    void onCloseTab(item.tab.tabId);
  }, [item.tab.tabId, onCloseTab]);
  const handleMoveToMain = useCallback(
    () => onMoveTabToMain(item.tab.tabId),
    [item.tab.tabId, onMoveTabToMain],
  );
  const canMoveToMain = panelTargetSupportsHost(normalizedServerId, item.tab.target, "main");
  const moveToMainLeading = useMemo(
    () => <ThemedArrowLeftToLine size={14} uniProps={mutedColorMapping} />,
    [],
  );
  const closeLeading = useMemo(() => <ThemedX size={14} uniProps={mutedColorMapping} />, []);
  const accessibilityState = useMemo(() => ({ selected: item.isActive }), [item.isActive]);
  const renderPresentation = useCallback(
    (presentation: WorkspaceTabPresentation) => (
      <ContextMenu>
        <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="triggerRef">
            <ContextMenuTrigger
              {...(dragHandleProps?.attributes as object | undefined)}
              {...(dragHandleProps?.listeners as object | undefined)}
              triggerRef={dragHandleProps?.setActivatorNodeRef as never}
              testID={`explorer-sidebar-tab-${item.tab.tabId}`}
              accessibilityRole="button"
              accessibilityLabel={presentation.tooltip}
              accessibilityState={accessibilityState}
              onPress={handlePress}
              onHoverIn={handleHoverIn}
              onHoverOut={handleHoverOut}
              style={[
                styles.tab,
                hovered ? styles.tabHovered : null,
                item.isActive ? styles.tabActive : null,
                isDragging ? styles.tabDragging : null,
              ]}
            >
              <WorkspaceTabIcon
                presentation={presentation}
                active={item.isActive}
                size={iconButtonChromeGlyphSize("small")}
                strokeWidth={1.5}
                backdrop={resolveExplorerSidebarTabBackdrop()}
              />
              <Text
                selectable={false}
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[styles.tabLabel, item.isActive ? styles.tabLabelActive : null]}
              >
                {presentation.label}
              </Text>
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <Text style={styles.tooltipText}>{presentation.tooltip}</Text>
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent align="start" minWidth={180}>
          {canMoveToMain ? (
            <ContextMenuItem leading={moveToMainLeading} onSelect={handleMoveToMain}>
              {t("workspace.tabs.menu.moveToMain")}
            </ContextMenuItem>
          ) : null}
          {canMoveToMain ? <ContextMenuSeparator /> : null}
          <ContextMenuItem leading={closeLeading} onSelect={handleClose}>
            {t("workspace.tabs.menu.close")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    ),
    [
      accessibilityState,
      dragHandleProps,
      handleHoverIn,
      handleHoverOut,
      handleClose,
      handleMoveToMain,
      handlePress,
      hovered,
      isDragging,
      item,
      canMoveToMain,
      closeLeading,
      moveToMainLeading,
      t,
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

function CatalogIcon({
  Icon,
  color = "",
}: {
  Icon: ComponentType<PanelIconProps>;
  color?: string;
}) {
  return <Icon size={14} color={color} />;
}

const ThemedCatalogIcon = withUnistyles(CatalogIcon);
const ThemedArrowLeftToLine = withUnistyles(ArrowLeftToLine);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedPlus = withUnistyles(Plus);
const ThemedX = withUnistyles(X);

function ExplorerSidebarConfigurationItem({ entry }: { entry: ExplorerSidebarConfigurationEntry }) {
  const leading = useMemo(() => {
    return entry.item.Icon ? (
      <ThemedCatalogIcon Icon={entry.item.Icon} uniProps={mutedColorMapping} />
    ) : null;
  }, [entry.item.Icon]);

  return (
    <MenuItem
      leading={leading}
      selected={entry.selected}
      showSelectedCheck
      disabled={entry.disabled}
      onSelect={entry.onSelect}
    >
      {entry.item.label}
    </MenuItem>
  );
}

function ExplorerSidebarConfigurationMenuItems({
  entries,
  onCreateNewTab,
}: {
  entries: ExplorerSidebarConfigurationEntry[];
  onCreateNewTab: () => void;
}) {
  const { t } = useTranslation();
  const newTabLeading = useMemo(() => <ThemedPlus size={14} uniProps={mutedColorMapping} />, []);

  return (
    <>
      <MenuItem leading={newTabLeading} onSelect={onCreateNewTab}>
        {t("workspace.tabs.actions.newTab")}
      </MenuItem>
      <MenuSeparator />
      {entries.map((entry) => (
        <ExplorerSidebarConfigurationItem key={entry.item.id} entry={entry} />
      ))}
    </>
  );
}

export function ExplorerSidebarTabRail({
  paneId,
  tabs,
  normalizedServerId,
  normalizedWorkspaceId,
  activeDragTabId,
  tabDropPreviewIndex,
  onNavigateTab,
  onCloseTab,
  onCreateNewTab,
  onMoveTabToMain,
  onReorderTabs,
  trailingAccessory,
}: ExplorerSidebarTabRailProps) {
  const scrollBoundary = useHorizontalScrollBoundary();
  const { t } = useTranslation();
  const groups = useWorkspaceTabLaunchCatalog({
    serverId: normalizedServerId,
    purpose: "supporting",
    host: "explorer",
  });
  const singletonConfigurationItems = useMemo(
    () =>
      (groups.find((group) => group.id === "tabs")?.items ?? []).filter(
        (item) => !panelSupportsHost(item.panelKind, "main"),
      ),
    [groups],
  );
  const configurationEntries = useMemo(
    () =>
      buildExplorerSidebarConfigurationEntries({
        items: singletonConfigurationItems,
        tabs: tabs.map((item) => item.tab),
        paneId,
        onCloseTab,
      }),
    [onCloseTab, paneId, singletonConfigurationItems, tabs],
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
          <ExplorerSidebarTab
            item={item}
            isDragging={isActive}
            dragHandleProps={dragHandleProps}
            onNavigateTab={onNavigateTab}
            onCloseTab={onCloseTab}
            onMoveTabToMain={onMoveTabToMain}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
          />
          {showAfter ? <View style={[styles.dropIndicator, styles.dropIndicatorAfter]} /> : null}
        </View>
      );
    },
    [
      activeDragTabId,
      normalizedServerId,
      normalizedWorkspaceId,
      onNavigateTab,
      onCloseTab,
      onMoveTabToMain,
      tabDropPreviewIndex,
      tabs.length,
    ],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        contextOnly
        style={[styles.track, titlebarDragSurfaceStyle as never]}
        testID="explorer-sidebar-tab-rail"
      >
        <View style={styles.scrollContainer}>
          <Animated.ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}
            onLayout={scrollBoundary.onLayout}
            onContentSizeChange={scrollBoundary.onContentSizeChange}
            onScroll={scrollBoundary.onScroll}
            scrollEventThrottle={16}
          >
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
          </Animated.ScrollView>
          <HorizontalScrollBoundaryShades
            visible
            backdrop="sidebar"
            testIDPrefix="explorer-sidebar-tabs-scroll-shade"
            leftStyle={scrollBoundary.leftShadeStyle}
            rightStyle={scrollBoundary.rightShadeStyle}
          />
        </View>
        <DropdownMenu>
          <ToolbarButton
            kind={EXPLORER_SIDEBAR_CONFIGURATION_TRIGGER.kind}
            label={t(EXPLORER_SIDEBAR_CONFIGURATION_TRIGGER.labelKey)}
            testID={EXPLORER_SIDEBAR_CONFIGURATION_TRIGGER.testID}
            style={[
              styles.configurationMenuTrigger,
              EXPLORER_SIDEBAR_CONFIGURATION_TRIGGER.titlebarStyle as never,
            ]}
          >
            <ThemedEllipsis size={14} uniProps={mutedColorMapping} />
          </ToolbarButton>
          <DropdownMenuContent
            side="bottom"
            align="end"
            offset={4}
            width={200}
            testID="explorer-sidebar-tab-configuration"
          >
            <ExplorerSidebarConfigurationMenuItems
              entries={configurationEntries}
              onCreateNewTab={onCreateNewTab}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        {trailingAccessory ? (
          <View style={styles.trailingAccessory}>{trailingAccessory}</View>
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuContent align="start" minWidth={200} testID="explorer-sidebar-tab-configuration">
        <ExplorerSidebarConfigurationMenuItems
          entries={configurationEntries}
          onCreateNewTab={onCreateNewTab}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    minWidth: 0,
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    backgroundColor: theme.colors.surfaceSidebar,
    flexDirection: "row",
    alignItems: "center",
  },
  scrollContainer: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
  },
  scrollContent: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  trailingAccessory: {
    marginRight: 4,
  },
  configurationMenuTrigger: {
    marginRight: 4,
  },
  tabSlot: {
    position: "relative",
    marginHorizontal: TAB_GAP / 2,
  },
  tab: {
    height: HEADER_CONTROL_HEIGHT,
    maxWidth: 180,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  tabHovered: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  tabActive: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  tabLabel: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    userSelect: "none",
  },
  tabLabelActive: {
    color: theme.colors.foreground,
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
