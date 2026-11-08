import { SidebarViewSlot } from "@/plugins/sidebar-view";
import { useAddHost } from "@/hosts/add-host";
import { router } from "expo-router";
import {
  CircleGauge,
  FolderPlus,
  GitBranch,
  Server,
  Settings,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, ScrollView as GHScrollView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarCloseButton } from "@/components/headers/sidebar-close-button";
import {
  resolveDesktopSidebarInsetLeft,
  resolveDesktopSidebarWidth,
} from "@/components/desktop-sidebar-layout";
import { useWindowLayout, resolveDesktopDivisionLayout } from "@/window-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { HostPicker } from "@/components/hosts/host-picker";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/display-preferences/menu";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { SidebarNavRows } from "@/components/sidebar/sidebar-nav-rows";
import { SidebarFooterIconHighlight } from "@/components/sidebar/sidebar-footer-icon-highlight";
import { SidebarHelpMenu } from "@/components/sidebar/sidebar-help-menu";
import { SidebarFooterOverflowMenu } from "@/components/sidebar/sidebar-footer-overflow-menu";
import {
  resolveSidebarFooterLayout,
  SIDEBAR_FOOTER_ACTIONS,
  type SidebarFooterAction,
} from "@/components/sidebar-footer-layout";
import {
  controlSizingForLayout,
  mapLayout,
  TOOLBAR_CONTROL_SIZES,
} from "@/components/ui/control-geometry";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { DensityIcon } from "@/components/ui/density-icon";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { isNative as platformIsNative } from "@/constants/platform";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useImportSession } from "@/hooks/use-import-session";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { density } from "@/styles/density";
import { SPACING } from "@/styles/theme";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { type SidebarGroupMode, useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useHosts } from "@/runtime/host-runtime";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { usePanelStore } from "@/stores/panel-store";
import { useOwnsWindowChromeCorner, WindowChromeSafeArea } from "@/utils/desktop-window";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { useLeftPanelWidth } from "@/mobile-panels/provider";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { buildSettingsRoute } from "@/utils/host-routes";
import { openHostOverview } from "@/navigation/settings-navigation";
import { UsageSidebarItem, UsageSidebarRoot, useUsageSummary, useOpenSidebarUsage } from "@/usage";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

/** The footer icon line's inset; the overflow layout counts it as space the buttons can't use. */
const FOOTER_ROW_PADDING = SPACING[2];

const DEV_BUILD_LABEL = process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;

interface SidebarSharedProps {
  theme: SidebarTheme;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  projects: SidebarProjectEntry[];
  hasProjectsBeforeFilter: boolean;
  hasActiveProjectFilter: boolean;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  groupMode: SidebarGroupMode;
  collapsedProjectKeys: ReadonlySet<string>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  handleRefresh: () => void;
  handleOpenProject: () => void;
  handleImportSession: () => void;
  handleSettings: () => void;
  labels: SidebarLabels;
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
}

interface SidebarLabels {
  addProject: string;
  hosts: string;
  settings: string;
  searchHosts: string;
  usage: string;
  closeSidebar: string;
}

interface MobileSidebarProps extends SidebarSharedProps {
  active: boolean;
  insetsTop: number;
  insetsBottom: number;
  closeSidebar: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  active: boolean;
  overlay: boolean;
}

export const LeftSidebar = memo(function LeftSidebar({
  active,
  desktopOverlay,
}: {
  active: boolean;
  desktopOverlay: boolean;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  const {
    projects,
    hasProjectsBeforeFilter,
    resolvedProjectFilters,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    refreshAll,
    workspaceGroups,
    projectIconTargets,
    pinnedGroups,
    collapsedProjectKeys,
    toggleProjectCollapsed,
    groupMode,
    shortcutModel,
  } = useSidebarModel();
  const { shortcutIndexByWorkspaceKey } = shortcutModel;

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const openProjectPicker = useOpenAddProject();
  const { open: openImportSession, sheet: importSessionSheet } = useImportSession();

  // Each destination closes the navigation overlay first. Closing is idempotent, so a docked
  // sidebar runs the same handler.
  const handleOpenProject = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettings = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsRoute());
  }, [showMobileAgent]);

  const handleAddHost = useAddHost();

  const handleOpenHostSettings = useCallback(
    (serverId: string) => {
      showMobileAgent();
      openHostOverview(serverId);
    },
    [showMobileAgent],
  );

  const labels = useMemo(
    (): SidebarLabels => ({
      addProject: t("sidebar.actions.addProject"),
      hosts: t("sidebar.actions.hosts"),
      settings: t("sidebar.actions.settings"),
      searchHosts: t("sidebar.host.searchPlaceholder"),
      usage: t(builtinSidebarNavLabelKey("usage")),
      closeSidebar: t("sidebar.actions.closeSidebar"),
    }),
    [t],
  );

  const sharedProps = {
    theme,
    workspaceGroups,
    projectIconTargets,
    pinnedGroups,
    projects,
    hasProjectsBeforeFilter,
    hasActiveProjectFilter: resolvedProjectFilters.length > 0,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    isManualRefresh,
    groupMode,
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    labels,
  };

  const handlers = {
    handleOpenProject,
    handleImportSession: openImportSession,
    handleSettings,
    handleAddHost,
    handleOpenHostSettings,
  };

  return (
    <>
      <RetainedPanelActivity active={active}>
        {isCompactLayout ? (
          <MobileSidebar
            {...sharedProps}
            {...handlers}
            active={active}
            insetsTop={insets.top}
            insetsBottom={insets.bottom}
            closeSidebar={showMobileAgent}
          />
        ) : (
          <DesktopSidebar
            {...sharedProps}
            {...handlers}
            insetsTop={insets.top}
            active={active}
            overlay={desktopOverlay}
          />
        )}
      </RetainedPanelActivity>
      {importSessionSheet}
    </>
  );
});

function sidebarHostOptionTestID(serverId: string): string {
  return `sidebar-host-row-${serverId}`;
}

function FooterIconButton({
  buttonRef,
  onPress,
  testID,
  label,
  icon,
  iconSizeAdjustment = 0,
  shortcutKeys,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  icon: LucideIcon;
  /** Only for a glyph that reads larger than the others at the same size. */
  iconSizeAdjustment?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  buttonRef?: RefObject<View | null>;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          style={styles.footerIconButton}
          testID={testID}
          nativeID={testID}
          collapsable={false}
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
        >
          {({ hovered, pressed }) => (
            <>
              <SidebarFooterIconHighlight visible={pressed} />
              <DensityIcon
                icon={icon}
                size="md"
                sizeAdjustment={iconSizeAdjustment}
                color={hovered ? "foreground" : "foregroundMuted"}
              />
            </>
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} testID={`${testID}-tooltip`}>
        <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarHostPicker({
  label,
  onAddHost,
  onOpenHostSettings,
}: {
  label: string;
  onAddHost: () => void;
  onOpenHostSettings: (serverId: string) => void;
}) {
  const hosts = useHosts();
  const triggerRef = useRef<View | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleSelect = useCallback(
    (id: string) => {
      onOpenHostSettings(id);
    },
    [onOpenHostSettings],
  );

  const handleOpen = useCallback(() => setIsOpen(true), []);

  return (
    <HostPicker
      hosts={hosts}
      value=""
      onSelect={handleSelect}
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={triggerRef}
      includeAddHost
      onAddHost={onAddHost}
      showActiveConnection
      onOpenHostSettings={onOpenHostSettings}
      searchable
      desktopPlacement="top-start"
      desktopMinWidth={240}
      addHostTestID="sidebar-host-add"
      hostOptionTestID={sidebarHostOptionTestID}
    >
      <FooterIconButton
        buttonRef={triggerRef}
        onPress={handleOpen}
        testID="sidebar-hosts-trigger"
        label={label}
        icon={Server}
        // Server's two boxes fill more of the square than the other glyphs.
        iconSizeAdjustment={-1}
      />
    </HostPicker>
  );
}

function IconTooltipContent({
  label,
  shortcutKeys,
}: {
  label: string;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
    </View>
  );
}

function SidebarFooter({
  handleOpenProject,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  onBeforeNavigate,
}: {
  handleOpenProject: () => void;
  handleSettings: () => void;
  labels: {
    addProject: string;
    hosts: string;
    settings: string;
    searchHosts: string;
    usage: string;
  };
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
  onBeforeNavigate?: () => void;
}) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const settingsKeys = useShortcutKeys("toggle-settings");
  const isCompactLayout = useIsCompactFormFactor();
  const [rowWidth, setRowWidth] = useState(0);
  const handleRowLayout = useCallback((event: LayoutChangeEvent) => {
    setRowWidth(event.nativeEvent.layout.width);
  }, []);
  const { inline, overflow } = useMemo(
    () =>
      resolveSidebarFooterLayout({
        rowWidth,
        controlSize: TOOLBAR_CONTROL_SIZES[controlSizingForLayout(isCompactLayout)],
        rowPadding: FOOTER_ROW_PADDING,
        actions: SIDEBAR_FOOTER_ACTIONS,
      }),
    [rowWidth, isCompactLayout],
  );
  const isInline = (action: SidebarFooterAction) => inline.includes(action);

  // One line of icons: Add project, Usage, Hosts, then Help and Settings at the end. Actions that
  // don't fit move behind a caret before Settings.
  return (
    <UsageSidebarRoot>
      <View style={styles.footerContainer} testID="sidebar-footer">
        <SidebarFooterRows onBeforeNavigate={onBeforeNavigate} />
        <View
          style={styles.sidebarFooter}
          onLayout={handleRowLayout}
          testID="sidebar-footer-bottom-line"
        >
          {isInline("add-project") ? (
            <FooterIconButton
              onPress={handleOpenProject}
              testID="sidebar-add-project"
              label={labels.addProject}
              icon={FolderPlus}
              shortcutKeys={newAgentKeys}
            />
          ) : null}
          {isInline("usage") ? <SidebarUsageIcon label={labels.usage} /> : null}
          {isInline("hosts") ? (
            <SidebarHostPicker
              label={labels.hosts}
              onAddHost={handleAddHost}
              onOpenHostSettings={handleOpenHostSettings}
            />
          ) : null}
          <View style={styles.footerSpacer} />
          {isInline("help") ? <SidebarHelpMenu /> : null}
          {overflow.length > 0 ? (
            <SidebarFooterOverflowMenu
              actions={overflow}
              labels={labels}
              onAddProject={handleOpenProject}
              onSettings={handleSettings}
              onAddHost={handleAddHost}
              onOpenHostSettings={handleOpenHostSettings}
            />
          ) : null}
          {isInline("settings") ? (
            <FooterIconButton
              onPress={handleSettings}
              testID="sidebar-settings"
              label={labels.settings}
              icon={Settings}
              shortcutKeys={settingsKeys}
            />
          ) : null}
        </View>
      </View>
    </UsageSidebarRoot>
  );
}

function SidebarUsageIcon({ label }: { label: string }) {
  const openUsage = useOpenSidebarUsage();
  return (
    <FooterIconButton
      onPress={openUsage}
      testID="sidebar-usage-icon"
      label={label}
      icon={CircleGauge}
    />
  );
}

/**
 * The footer rows in the user's `sidebarFooterItems` order: the Usage item and plugin rows. The
 * Usage item is left out while it has no summary to show.
 */
function SidebarFooterRows({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { items } = useSidebarNavItems("footer");
  const usageSummary = useUsageSummary();
  const rowsRef = useRef<View | null>(null);
  const visibleItems = items.filter(
    (item) => item.visible && (item.kind === "plugin" || usageSummary.length > 0),
  );
  if (visibleItems.length === 0) return null;
  return (
    <>
      <View ref={rowsRef} collapsable={false} style={styles.footerRows}>
        {visibleItems.map((item) =>
          item.kind === "plugin" ? (
            <PluginSidebarItem
              key={item.key}
              group={item.group}
              section="footer"
              fallbackAnchorRef={rowsRef}
              onBeforeNavigate={onBeforeNavigate}
            />
          ) : (
            <UsageSidebarItem key={item.key} sources={usageSummary} />
          ),
        )}
      </View>
      <SidebarSeparator testID="sidebar-footer-separator" />
    </>
  );
}

function MobileSidebar({
  active,
  theme,
  workspaceGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleImportSession,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsTop,
  insetsBottom,
  closeSidebar,
}: MobileSidebarProps) {
  const insets = useSafeAreaInsets();
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();

  const handleWorkspacePress = useCallback(() => {
    closeSidebar();
  }, [closeSidebar]);

  const closeButton = useMemo(
    () => (
      <SidebarCloseButton
        label={labels.closeSidebar}
        onPress={closeSidebar}
        testID="sidebar-close"
        nativeID="sidebar-close"
        style={styles.mobileCloseButton(insets.right)}
      />
    ),
    [labels.closeSidebar, closeSidebar, insets.right],
  );

  const mobileSidebarInsetStyle = useMemo(
    () => ({
      paddingTop: insetsTop,
      paddingBottom: insetsBottom,
      backgroundColor: theme.colors.surfaceSidebar,
    }),
    [insetsTop, insetsBottom, theme.colors.surfaceSidebar],
  );

  const navRows = (
    <SidebarNavRows
      style={styles.mobileNavRowsGroup}
      onBeforeNavigate={closeSidebar}
      firstRowTrailing={closeButton}
    />
  );

  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
    >
      <View style={styles.sidebarContent} pointerEvents="auto">
        <WindowChromeSafeArea placement="below" />
        {platformIsNative ? (
          <GHScrollView
            // Same contract as the workspace list: vertical drags scroll the nav
            // block, a clear horizontal intent still activates the close pan.
            simultaneousHandlers={closeGestureRef}
            style={styles.mobileNavScroll}
            showsVerticalScrollIndicator={false}
            alwaysBounceVertical={false}
            testID="sidebar-nav-scroll"
          >
            {navRows}
          </GHScrollView>
        ) : (
          <ScrollView
            style={styles.mobileNavScroll}
            showsVerticalScrollIndicator={false}
            alwaysBounceVertical={false}
            testID="sidebar-nav-scroll"
          >
            {navRows}
          </ScrollView>
        )}
        <SidebarSeparator />

        <SidebarViewSlot dismiss={handleWorkspacePress}>
          {isInitialLoad && !hasActiveHostFilter ? (
            <SidebarAgentListSkeleton />
          ) : (
            <SidebarWorkspaceList
              collapsedProjectKeys={collapsedProjectKeys}
              onToggleProjectCollapsed={toggleProjectCollapsed}
              shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
              groupMode={groupMode}
              workspaceGroups={workspaceGroups}
              projectIconTargets={projectIconTargets}
              pinnedGroups={pinnedGroups}
              projects={projects}
              hasProjectsBeforeFilter={hasProjectsBeforeFilter}
              hasActiveProjectFilter={hasActiveProjectFilter}
              workspaceEntriesByKey={workspaceEntriesByKey}
              isRefreshing={isManualRefresh && isRevalidating}
              onRefresh={handleRefresh}
              onWorkspacePress={handleWorkspacePress}
              onAddProject={handleOpenProject}
              onImportSession={handleImportSession}
              parentGestureRef={closeGestureRef}
              dragGestureHostActive={active}
              listHeaderComponent={workspacesSectionHeaderElement}
            />
          )}
        </SidebarViewSlot>

        <SidebarFooter
          handleOpenProject={handleOpenProject}
          handleSettings={handleSettings}
          labels={labels}
          handleAddHost={handleAddHost}
          handleOpenHostSettings={handleOpenHostSettings}
          onBeforeNavigate={closeSidebar}
        />
      </View>
    </MobilePanelOverlay>
  );
}

function DesktopSidebar({
  theme,
  workspaceGroups,
  projectIconTargets,
  pinnedGroups,
  projects,
  hasProjectsBeforeFilter,
  hasActiveProjectFilter,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleOpenProject,
  handleImportSession,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsTop,
  active,
  overlay,
}: DesktopSidebarProps) {
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const viewportWidth = windowWidth - insets.left - insets.right;
  const divisionLayout = resolveDesktopDivisionLayout({
    geometry: useWindowLayout(),
    windowWidth,
    windowHeight,
    leftInset: insets.left,
    rightInset: insets.right,
  });
  const visibleSidebarWidth = useLeftPanelWidth();

  const closeSidebar = usePanelStore((state) => state.showMobileAgent);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture(overlay);

  const startWidth = useSharedValue(visibleSidebarWidth);
  const resizeWidth = useSharedValue(visibleSidebarWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleSidebarWidth;
  }, [resizeWidth, visibleSidebarWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(divisionLayout === null)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // Horizontal intent only, so a finger dragging down the touch grip scrolls
        // the workspace list instead of resizing. Anchoring the start width to the
        // activation translation keeps the extra threshold from jumping the edge.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidth.value = visibleSidebarWidth - event.translationX;
          resizeWidth.value = visibleSidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidth.value + event.translationX;
          resizeWidth.value = resolveDesktopSidebarWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd((_event, success) => {
          if (success) runOnJS(setSidebarWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      divisionLayout,
      hideResizeGrip,
      resizeWidth,
      setSidebarWidth,
      showResizeGrip,
      startWidth,
      viewportWidth,
      visibleSidebarWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: divisionLayout?.sidebarWidth ?? resizeWidth.value,
  }));
  // The panel host gets no width of its own: the dock sizes to this view and the overlay fills the
  // window. A Reanimated width on the host reached Android after React had switched presentation,
  // and a lost update left the workspace at the dock width after the dock collapsed.
  const desktopSidebarStyle = useMemo(
    () => [staticStyles.desktopSidebar, resizeAnimatedStyle],
    [resizeAnimatedStyle],
  );
  const desktopSidebarBorderStyle = useMemo(
    () => [
      styles.desktopSidebarBorder(divisionLayout !== null),
      {
        flex: 1,
        paddingTop: insetsTop,
        paddingBottom: insets.bottom,
        paddingLeft: resolveDesktopSidebarInsetLeft({ overlay, safeAreaLeft: insets.left }),
      },
    ],
    [insetsTop, insets.bottom, insets.left, overlay, divisionLayout],
  );
  const sidebarHeaderGroupStyle = useMemo(
    () => [styles.sidebarHeaderGroup, ownsTopLeft && styles.sidebarHeaderGroupBelowChrome],
    [ownsTopLeft],
  );
  return (
    <MobilePanelOverlay
      panel="agent-list"
      presentation={overlay ? "overlay" : "dock"}
      dockVisible={active}
      closeGesture={closeGesture}
    >
      <Animated.View style={desktopSidebarStyle}>
        <View style={desktopSidebarBorderStyle}>
          <View style={styles.sidebarDragArea}>
            {ownsTopLeft || DEV_BUILD_LABEL ? (
              <View style={styles.desktopChromeRow}>
                <TitlebarDragRegion />
                {DEV_BUILD_LABEL ? (
                  <View
                    pointerEvents="none"
                    style={styles.devBuildBadge}
                    testID="dev-build-label"
                    accessibilityLabel={`Development build: ${DEV_BUILD_LABEL}`}
                  >
                    <GitBranch size={12} color={theme.colors.accentForeground} />
                    <Text numberOfLines={1} ellipsizeMode="tail" style={styles.devBuildBadgeText}>
                      {DEV_BUILD_LABEL}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : (
              <TitlebarDragRegion />
            )}
            <SidebarNavRows style={sidebarHeaderGroupStyle} onBeforeNavigate={closeSidebar} />
          </View>

          <SidebarViewSlot dismiss={closeSidebar}>
            {isInitialLoad && !hasActiveHostFilter ? (
              <SidebarAgentListSkeleton />
            ) : (
              <SidebarWorkspaceList
                collapsedProjectKeys={collapsedProjectKeys}
                onToggleProjectCollapsed={toggleProjectCollapsed}
                shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
                groupMode={groupMode}
                workspaceGroups={workspaceGroups}
                projectIconTargets={projectIconTargets}
                pinnedGroups={pinnedGroups}
                projects={projects}
                hasProjectsBeforeFilter={hasProjectsBeforeFilter}
                hasActiveProjectFilter={hasActiveProjectFilter}
                workspaceEntriesByKey={workspaceEntriesByKey}
                isRefreshing={isManualRefresh && isRevalidating}
                onRefresh={handleRefresh}
                onAddProject={handleOpenProject}
                onImportSession={handleImportSession}
                onWorkspacePress={closeSidebar}
                parentGestureRef={closeGestureRef}
                dragGestureHostActive={active}
                listHeaderComponent={workspacesSectionHeaderElement}
              />
            )}
          </SidebarViewSlot>

          <SidebarCalloutSlot />

          <SidebarFooter
            handleOpenProject={handleOpenProject}
            handleSettings={handleSettings}
            labels={labels}
            handleAddHost={handleAddHost}
            handleOpenHostSettings={handleOpenHostSettings}
            onBeforeNavigate={closeSidebar}
          />

          {!overlay && divisionLayout === null ? (
            <SidebarResizeHandle
              edge="right"
              gesture={resizeGesture}
              pressed={resizePressed}
              testID="left-sidebar-resize-handle"
            />
          ) : null}
        </View>
      </Animated.View>
    </MobilePanelOverlay>
  );
}

function WorkspacesSectionHeader() {
  return (
    <SidebarSectionHeader title="Workspaces">
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <View>
            <SidebarDisplayPreferencesMenu />
          </View>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <IconTooltipContent label="Display preferences" />
        </TooltipContent>
      </Tooltip>
    </SidebarSectionHeader>
  );
}

// Stable element so the sidebar list's listHeaderComponent prop keeps identity across
// renders (WorkspacesSectionHeader takes no props).
const workspacesSectionHeaderElement = <WorkspacesSectionHeader />;

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
    flex: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  sidebarHeaderGroup: {
    paddingTop: theme.spacing[2],
    gap: 2,
    paddingBottom: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  sidebarHeaderGroupBelowChrome: {
    paddingTop: 0,
  },
  // The nav block caps at half the sidebar; a long item list scrolls inside the
  // cap instead of crowding the workspace list off a short screen.
  mobileNavScroll: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: "50%",
  },
  mobileNavRowsGroup: {
    paddingTop: theme.spacing[2],
    gap: 2,
    paddingBottom: theme.spacing[1.5],
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  mobileCloseButton: (rightInset: number) => ({
    marginRight: theme.spacing[2] + rightInset,
  }),
  desktopSidebarBorder: (hasDivision: boolean) => ({
    borderRightWidth: hasDivision ? 0 : 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  }),
  sidebarDragArea: {
    position: "relative",
  },
  desktopChromeRow: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
  devBuildBadge: {
    maxWidth: "60%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  devBuildBadgeText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  footerContainer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  // Buttons sit edge to edge; their own inset spaces the glyphs.
  // As tall as its buttons from the first frame, which places none until the row has measured.
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: mapLayout(density.iconButton, (height) => height + theme.spacing[1.5] * 2),
    paddingHorizontal: FOOTER_ROW_PADDING,
    paddingVertical: theme.spacing[1.5],
  },
  // Pushes Help and Settings to the end of the icon line.
  footerSpacer: {
    flex: 1,
  },
  // Usage and plugin rows sit above the footer's icon line, spaced like the header nav rows.
  footerRows: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    gap: 2,
  },
  footerIconButton: {
    width: density.iconButton,
    height: density.iconButton,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
