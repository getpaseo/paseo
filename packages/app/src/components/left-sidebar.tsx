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
  StyleSheet as RNStyleSheet,
  type LayoutChangeEvent,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture } from "react-native-gesture-handler";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarCloseButton } from "@/components/headers/sidebar-close-button";
import { TopBarSafeArea } from "@/components/headers/top-bar-safe-area";
import {
  resolveSidebarFooterLayout,
  resolveSidebarFooterBarLayout,
  resolveSidebarFooterKeyboardSpacing,
  SIDEBAR_FOOTER_GROUP_GAP,
  SIDEBAR_FOOTER_MIN_BUTTON_WIDTH,
  SIDEBAR_FOOTER_ROW_PADDING,
} from "@/components/sidebar-footer-layout";
import { ContentBandGeometryProbe } from "@/components/headers/content-band-geometry";
import {
  resolveContentBandPlacement,
  type ContentBandGeometry,
  type ContentBandInsets,
  type ContentBandRect,
} from "@/components/headers/content-band-geometry.shared";
import { COMPACT_LARGE_ICON_BUTTON_SIZE } from "@/components/ui/icon-button-chrome";
import { resolveDesktopSidebarWidth } from "@/components/desktop-sidebar-layout";
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
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { DensityIcon } from "@/components/ui/density-icon";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { supportsModernWindowLayout } from "@/constants/modern-window-layout";
import {
  BottomBarGeometryProbe,
  type BottomBarGeometry,
} from "@/components/headers/bottom-bar-geometry";
import { MIN_SIDEBAR_WIDTH } from "@/stores/panel-store/state";
import { useKeyboardShift } from "@/keyboard/shift";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useImportSession } from "@/hooks/use-import-session";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { density } from "@/styles/density";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
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
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { buildSettingsAddHostRoute, buildSettingsRoute } from "@/utils/host-routes";
import { openHostOverview } from "@/navigation/settings-navigation";
import { UsageSidebarItem, UsageSidebarRoot, useUsageSummary, useOpenSidebarUsage } from "@/usage";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

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
}

export const LeftSidebar = memo(function LeftSidebar({ active }: { active: boolean }) {
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

  const handleOpenProjectMobile = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleOpenProjectDesktop = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettingsMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsRoute());
  }, [showMobileAgent]);

  const handleSettingsDesktop = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);

  const handleAddHostMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsAddHostRoute(Date.now()));
  }, [showMobileAgent]);

  const handleAddHostDesktop = useCallback(() => {
    router.push(buildSettingsAddHostRoute(Date.now()));
  }, []);

  const handleOpenHostSettingsMobile = useCallback(
    (serverId: string) => {
      showMobileAgent();
      openHostOverview(serverId);
    },
    [showMobileAgent],
  );

  const handleOpenHostSettingsDesktop = useCallback((serverId: string) => {
    openHostOverview(serverId);
  }, []);

  const handleImportSessionMobile = useCallback(() => {
    openImportSession();
  }, [openImportSession]);

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

  if (isCompactLayout) {
    return (
      <>
        <RetainedPanelActivity active={active}>
          <MobileSidebar
            {...sharedProps}
            active={active}
            insetsTop={insets.top}
            insetsBottom={insets.bottom}
            closeSidebar={showMobileAgent}
            handleOpenProject={handleOpenProjectMobile}
            handleImportSession={handleImportSessionMobile}
            handleSettings={handleSettingsMobile}
            handleAddHost={handleAddHostMobile}
            handleOpenHostSettings={handleOpenHostSettingsMobile}
          />
        </RetainedPanelActivity>
        {importSessionSheet}
      </>
    );
  }

  return (
    <>
      <RetainedPanelActivity active={active}>
        <DesktopSidebar
          {...sharedProps}
          insetsTop={insets.top}
          active={active}
          handleOpenProject={handleOpenProjectDesktop}
          handleImportSession={openImportSession}
          handleSettings={handleSettingsDesktop}
          handleAddHost={handleAddHostDesktop}
          handleOpenHostSettings={handleOpenHostSettingsDesktop}
        />
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
  buttonWidth,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  icon: LucideIcon;
  /** Only for a glyph that reads larger than the others at the same size. */
  iconSizeAdjustment?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  buttonRef?: RefObject<View | null>;
  buttonWidth?: number;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          style={
            buttonWidth === undefined
              ? styles.footerIconButton
              : [styles.footerIconButton, inlineUnistylesStyle({ width: buttonWidth })]
          }
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
  buttonWidth,
}: {
  label: string;
  onAddHost: () => void;
  onOpenHostSettings: (serverId: string) => void;
  buttonWidth?: number;
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
        buttonWidth={buttonWidth}
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

interface SidebarFooterProps {
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
  onMinimumWidthChange?: (width: number) => void;
  onBarHeightChange?: (height: number) => void;
  edgeInsets?: ContentBandInsets;
  requiredMinimumWidth?: number;
  available?: boolean;
}

function SidebarFooter({ onBeforeNavigate, ...props }: SidebarFooterProps) {
  return (
    <UsageSidebarRoot>
      <View style={styles.footerContainer} testID="sidebar-footer">
        <SidebarFooterRows onBeforeNavigate={onBeforeNavigate} />
        {supportsModernWindowLayout ? (
          <ModernSidebarFooterLine {...props} />
        ) : (
          <View style={styles.sidebarFooter} testID="sidebar-footer-bottom-line">
            <SidebarFooterActions {...props} />
          </View>
        )}
      </View>
    </UsageSidebarRoot>
  );
}

function SidebarFooterActions({
  handleOpenProject,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  buttonWidth,
}: Omit<
  SidebarFooterProps,
  | "onBeforeNavigate"
  | "onMinimumWidthChange"
  | "onBarHeightChange"
  | "edgeInsets"
  | "requiredMinimumWidth"
  | "available"
> & {
  buttonWidth?: number;
}) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const settingsKeys = useShortcutKeys("toggle-settings");
  const leadingButtons = (
    <>
      <FooterIconButton
        buttonWidth={buttonWidth}
        onPress={handleOpenProject}
        testID="sidebar-add-project"
        label={labels.addProject}
        icon={FolderPlus}
        shortcutKeys={newAgentKeys}
      />
      <SidebarUsageIcon label={labels.usage} buttonWidth={buttonWidth} />
      <SidebarHostPicker
        buttonWidth={buttonWidth}
        label={labels.hosts}
        onAddHost={handleAddHost}
        onOpenHostSettings={handleOpenHostSettings}
      />
    </>
  );
  const trailingButtons = (
    <>
      <SidebarHelpMenu buttonWidth={buttonWidth} />
      <FooterIconButton
        buttonWidth={buttonWidth}
        onPress={handleSettings}
        testID="sidebar-settings"
        label={labels.settings}
        icon={Settings}
        shortcutKeys={settingsKeys}
      />
    </>
  );

  return (
    <>
      {supportsModernWindowLayout ? (
        <View style={styles.footerGroup} testID="sidebar-footer-leading-group" collapsable={false}>
          {leadingButtons}
        </View>
      ) : (
        leadingButtons
      )}
      <View
        style={
          supportsModernWindowLayout
            ? [styles.footerSpacer, styles.modernFooterSpacer]
            : styles.footerSpacer
        }
        testID={supportsModernWindowLayout ? "sidebar-footer-group-gap" : undefined}
      />
      {supportsModernWindowLayout ? (
        <View style={styles.footerGroup} testID="sidebar-footer-trailing-group" collapsable={false}>
          {trailingButtons}
        </View>
      ) : (
        trailingButtons
      )}
    </>
  );
}

function ModernSidebarFooterLine({
  onMinimumWidthChange,
  onBarHeightChange,
  edgeInsets,
  requiredMinimumWidth,
  available = true,
  ...props
}: Omit<SidebarFooterProps, "onBeforeNavigate">) {
  const [rowSize, setRowSize] = useState(() => ({ width: 0, height: 0 }));
  const handleRowLayout = useCallback(
    ({ nativeEvent }: LayoutChangeEvent) => {
      const { width, height } = nativeEvent.layout;
      if (width <= 0 || height <= 0) return;
      onBarHeightChange?.(height);
      setRowSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    },
    [onBarHeightChange],
  );
  const layout = useMemo(
    () =>
      resolveSidebarFooterLayout({
        width: rowSize.width,
        buttonSize: Math.max(
          SIDEBAR_FOOTER_MIN_BUTTON_WIDTH,
          rowSize.height - 2 * SIDEBAR_FOOTER_ROW_PADDING,
        ),
        edgeInsets: edgeInsets ?? { left: 0, right: 0 },
      }),
    [rowSize.width, rowSize.height, edgeInsets],
  );
  useEffect(() => {
    onMinimumWidthChange?.(Math.max(layout.minimumWidth, requiredMinimumWidth ?? 0));
  }, [layout.minimumWidth, requiredMinimumWidth, onMinimumWidthChange]);

  return (
    <View
      style={[
        styles.sidebarFooter,
        styles.modernSidebarFooter,
        !available && inlineUnistylesStyle({ opacity: 0 }),
        inlineUnistylesStyle({
          paddingLeft: layout.paddingLeft,
          paddingRight: layout.paddingRight,
        }),
      ]}
      testID="sidebar-footer-bottom-line"
      onLayout={handleRowLayout}
      collapsable={false}
      pointerEvents={available ? "auto" : "none"}
      accessibilityElementsHidden={!available}
      importantForAccessibility={available ? "auto" : "no-hide-descendants"}
    >
      <RetainedPanelActivity active={available}>
        <SidebarFooterActions {...props} buttonWidth={layout.buttonWidth} />
      </RetainedPanelActivity>
    </View>
  );
}

function SidebarUsageIcon({ label, buttonWidth }: { label: string; buttonWidth?: number }) {
  const openUsage = useOpenSidebarUsage();
  return (
    <FooterIconButton
      buttonWidth={buttonWidth}
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

function useSidebarFooterBar() {
  const [extent, setExtent] = useState(0);
  const [geometry, setGeometry] = useState<BottomBarGeometry | null>(null);
  const insets = useSafeAreaInsets();
  const layout = useMemo(
    () => resolveSidebarFooterBarLayout({ geometry, safeAreaBottom: insets.bottom }),
    [geometry, insets.bottom],
  );
  const probe =
    supportsModernWindowLayout && extent > 0 ? (
      <BottomBarGeometryProbe adaptHorizontalEdges extent={extent} onGeometryChange={setGeometry} />
    ) : null;
  return {
    ...layout,
    probe,
    onBarHeightChange: supportsModernWindowLayout ? setExtent : undefined,
  };
}

function useSidebarFirstRowGeometry(topInset: number, gutter: number) {
  const [frame, setFrame] = useState<ContentBandRect | null>(null);
  const [geometry, setGeometry] = useState<ContentBandGeometry | null>(null);
  const placement = useMemo(
    () =>
      geometry
        ? resolveContentBandPlacement({
            width: geometry.bounds.width,
            height: geometry.bounds.height,
            placementBounds: geometry.placementBounds,
            margins: geometry.margins,
            exclusions: geometry.exclusions,
            minimumInsets: { left: gutter, right: gutter },
            minimumContentWidth: 2 * COMPACT_LARGE_ICON_BUTTON_SIZE,
            direction: "down",
          })
        : null,
    [geometry, gutter],
  );
  const handleLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const next = nativeEvent.layout;
    if (next.width <= 0 || next.height <= 0) return;
    setFrame((previous) =>
      previous?.x === next.x &&
      previous.y === next.y &&
      previous.width === next.width &&
      previous.height === next.height
        ? previous
        : next,
    );
  }, []);
  const style = useMemo(() => {
    if (placement?.kind !== "placed") return undefined;
    const required = placement.insets;
    // The navigation item's container and close button already own their gutters.
    return inlineUnistylesStyle({
      paddingLeft: Math.max(0, required.left - gutter),
      paddingRight: Math.max(0, required.right - gutter),
      transform: [{ translateY: placement.offsetY }],
      marginBottom: placement.offsetY,
    });
  }, [placement, gutter]);
  const probeStyle = useMemo(
    () =>
      frame
        ? {
            position: "absolute" as const,
            left: frame.x,
            top: topInset + frame.y,
            width: frame.width,
            height: frame.height,
          }
        : undefined,
    [frame, topInset],
  );
  const probe =
    supportsModernWindowLayout && frame ? (
      <ContentBandGeometryProbe style={probeStyle} onGeometryChange={setGeometry} />
    ) : null;
  return {
    probe,
    style,
    available: placement?.kind !== "unavailable",
    onLayout: supportsModernWindowLayout ? handleLayout : undefined,
  };
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
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();
  const footerBar = useSidebarFooterBar();
  const firstRow = useSidebarFirstRowGeometry(insetsTop, theme.spacing[2]);

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
        style={styles.mobileCloseButton}
      />
    ),
    [labels.closeSidebar, closeSidebar],
  );

  const mobileSidebarInsetStyle = useMemo(
    () => ({
      paddingTop: insetsTop,
      paddingBottom: supportsModernWindowLayout ? 0 : insetsBottom,
      backgroundColor: theme.colors.surfaceSidebar,
    }),
    [insetsTop, insetsBottom, theme.colors.surfaceSidebar],
  );

  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
      probe={
        supportsModernWindowLayout ? (
          <>
            {footerBar.probe}
            {firstRow.probe}
          </>
        ) : undefined
      }
    >
      <View
        style={[
          styles.sidebarContent,
          supportsModernWindowLayout &&
            inlineUnistylesStyle({ paddingBottom: footerBar.bottomPadding }),
        ]}
        pointerEvents="auto"
      >
        <WindowChromeSafeArea placement="below" />
        <SidebarNavRows
          style={styles.sidebarHeaderGroup}
          onBeforeNavigate={closeSidebar}
          firstRowTrailing={closeButton}
          firstRowStyle={firstRow.style}
          onFirstRowLayout={firstRow.onLayout}
          firstRowAvailable={firstRow.available}
        />

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

        <SidebarFooter
          edgeInsets={footerBar.edgeInsets}
          onBarHeightChange={footerBar.onBarHeightChange}
          available={footerBar.available}
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
}: DesktopSidebarProps) {
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const sidebarMinimumWidth = usePanelStore((state) =>
    supportsModernWindowLayout ? state.sidebarMinimumWidth : MIN_SIDEBAR_WIDTH,
  );
  const setSidebarMinimumWidth = usePanelStore((state) => state.setSidebarMinimumWidth);
  const handleFooterMinimumWidthChange = useCallback(
    (width: number) => setSidebarMinimumWidth(Math.ceil(width + theme.borderWidth[1])),
    [setSidebarMinimumWidth, theme.borderWidth],
  );
  const footerBar = useSidebarFooterBar();
  const { layoutShift: keyboardLayoutShift } = useKeyboardShift();
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const footerKeyboardStyle = useAnimatedStyle(
    () => ({
      height: resolveSidebarFooterKeyboardSpacing({
        keyboardHeight: keyboardHeight.value,
        layoutShift: keyboardLayoutShift.value,
        restingBottom: footerBar.bottomPadding,
      }),
      flexShrink: 0,
    }),
    [footerBar.bottomPadding],
  );
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const viewportWidth = windowWidth - insets.left - insets.right;
  const visibleSidebarWidth = resolveDesktopSidebarWidth({
    requestedWidth: sidebarWidth,
    viewportWidth,
    minimumWidth: sidebarMinimumWidth,
  });

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
            minimumWidth: sidebarMinimumWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setSidebarWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      hideResizeGrip,
      resizeWidth,
      startWidth,
      sidebarMinimumWidth,
      setSidebarWidth,
      showResizeGrip,
      viewportWidth,
      visibleSidebarWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  const desktopSidebarStyle = useMemo(
    () => [
      staticStyles.desktopSidebar,
      !active && staticStyles.desktopSidebarHidden,
      resizeAnimatedStyle,
    ],
    [active, resizeAnimatedStyle],
  );
  const desktopSidebarBorderStyle = useMemo(
    () => [
      styles.desktopSidebarBorder,
      supportsModernWindowLayout
        ? { flex: 1 }
        : { flex: 1, paddingTop: insetsTop, paddingBottom: insets.bottom },
      supportsModernWindowLayout && {
        paddingBottom: footerBar.bottomPadding,
      },
    ],
    [insetsTop, insets.bottom, footerBar.bottomPadding],
  );
  const sidebarHeaderGroupStyle = useMemo(
    () => [
      styles.sidebarHeaderGroup,
      (supportsModernWindowLayout || ownsTopLeft) && styles.sidebarHeaderGroupBelowChrome,
    ],
    [ownsTopLeft],
  );
  const [navigationHeight, setNavigationHeight] = useState(HEADER_INNER_HEIGHT);
  const handleNavigationLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setNavigationHeight(height);
    }
  }, []);
  const sidebarNavigation = (
    <View
      style={styles.sidebarDragArea}
      onLayout={supportsModernWindowLayout ? handleNavigationLayout : undefined}
    >
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
      <SidebarNavRows style={sidebarHeaderGroupStyle} />
    </View>
  );
  return (
    <Animated.View
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      pointerEvents={active ? "auto" : "none"}
      style={desktopSidebarStyle}
    >
      <View style={desktopSidebarBorderStyle}>
        {footerBar.probe}
        {supportsModernWindowLayout ? (
          <TopBarSafeArea
            contentHeight={navigationHeight}
            primaryRowHeight={HEADER_INNER_HEIGHT}
            horizontalContentPadding={theme.spacing[2]}
            navigationGroup
          >
            {sidebarNavigation}
          </TopBarSafeArea>
        ) : (
          sidebarNavigation
        )}

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
            listHeaderComponent={workspacesSectionHeaderElement}
          />
        )}

        <SidebarCalloutSlot />

        <SidebarFooter
          edgeInsets={footerBar.edgeInsets}
          requiredMinimumWidth={footerBar.requiredMinimumWidth}
          onMinimumWidthChange={
            supportsModernWindowLayout ? handleFooterMinimumWidthChange : undefined
          }
          onBarHeightChange={footerBar.onBarHeightChange}
          handleOpenProject={handleOpenProject}
          handleSettings={handleSettings}
          available={footerBar.available}
          labels={labels}
          handleAddHost={handleAddHost}
          handleOpenHostSettings={handleOpenHostSettings}
        />
        {supportsModernWindowLayout ? <Animated.View style={footerKeyboardStyle} /> : null}

        <SidebarResizeHandle
          edge="right"
          gesture={resizeGesture}
          pressed={resizePressed}
          testID="left-sidebar-resize-handle"
        />
      </View>
    </Animated.View>
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
  },
  desktopSidebarHidden: {
    display: "none",
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
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  mobileCloseButton: {
    marginRight: theme.spacing[2],
  },
  desktopSidebarBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
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
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  modernSidebarFooter: {
    position: "relative",
  },
  footerGroup: {
    flexDirection: "row",
    flexShrink: 0,
  },
  footerSpacer: {
    flex: 1,
  },
  modernFooterSpacer: {
    minWidth: SIDEBAR_FOOTER_GROUP_GAP,
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
