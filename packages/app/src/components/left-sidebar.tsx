import { router, usePathname } from "expo-router";
import { Clock, FolderPlus, Home, Plus, Search, Settings, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  type Dispatch,
  memo,
  type ReactElement,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarGroupingSelector } from "@/components/sidebar/sidebar-grouping-selector";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useSidebarAnimation } from "@/contexts/sidebar-animation-context";
import { useOpenProjectPicker } from "@/hooks/use-open-project-picker";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useSidebarShortcutModel } from "@/hooks/use-sidebar-shortcut-model";
import {
  type SidebarProjectEntry,
  useSidebarWorkspacesList,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarViewStore, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  selectIsAgentListOpen,
  usePanelStore,
} from "@/stores/panel-store";
import { resolveActiveHost } from "@/utils/active-host";
import { formatConnectionStatus } from "@/utils/daemons";
import { useWindowControlsPadding } from "@/utils/desktop-window";
import { canCloseLeftSidebarGesture } from "@/utils/sidebar-animation-state";
import {
  buildHostOpenProjectRoute,
  buildHostNewWorkspaceRoute,
  buildHostSessionsRoute,
  buildSettingsRoute,
  mapPathnameToServer,
} from "@/utils/host-routes";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

const MIN_CHAT_WIDTH = 400;

type SidebarShortcutModel = ReturnType<typeof useSidebarShortcutModel>;
type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

interface LeftSidebarProps {
  selectedAgentId?: string;
}

interface SidebarSharedProps {
  theme: SidebarTheme;
  activeServerId: string | null;
  activeHostLabel: string;
  activeHostStatusColor: string;
  hostOptions: ComboboxOption[];
  hostTriggerRef: RefObject<View | null>;
  isHostPickerOpen: boolean;
  setIsHostPickerOpen: Dispatch<SetStateAction<boolean>>;
  projects: SidebarProjectEntry[];
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  groupMode: SidebarGroupMode;
  collapsedProjectKeys: SidebarShortcutModel["collapsedProjectKeys"];
  shortcutIndexByWorkspaceKey: SidebarShortcutModel["shortcutIndexByWorkspaceKey"];
  toggleProjectCollapsed: SidebarShortcutModel["toggleProjectCollapsed"];
  handleRefresh: () => void;
  handleHostSelect: (nextServerId: string) => void;
  handleNewWorkspaceNavigate: () => void;
  handleOpenProject: () => void;
  handleHome: () => void;
  handleSettings: () => void;
  labels: SidebarLabels;
  renderHostOption: (input: {
    option: ComboboxOption;
    selected: boolean;
    active: boolean;
    onPress: () => void;
  }) => ReactElement;
}

interface SidebarLabels {
  addProject: string;
  newWorkspace: string;
  home: string;
  settings: string;
  switchHost: string;
  searchHosts: string;
  sessions: string;
  closeSidebar: string;
}

interface MobileSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  insetsBottom: number;
  isOpen: boolean;
  closeSidebar: () => void;
  handleViewMoreNavigate: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  isOpen: boolean;
  handleViewMore: () => void;
}

export const LeftSidebar = memo(function LeftSidebar({
  selectedAgentId: _selectedAgentId,
}: LeftSidebarProps) {
  void _selectedAgentId;

  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const isOpen = usePanelStore((state) =>
    selectIsAgentListOpen(state, { isCompact: isCompactLayout }),
  );
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const pathname = usePathname();
  const daemons = useHosts();
  const activeDaemon = useMemo(
    () => resolveActiveHost({ hosts: daemons, pathname }),
    [daemons, pathname],
  );
  const activeServerId = activeDaemon?.serverId ?? null;
  const activeHostLabel = useMemo(() => {
    if (!activeDaemon) return t("sidebar.host.noHost");
    const trimmed = activeDaemon.label?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : activeDaemon.serverId;
  }, [activeDaemon, t]);
  const activeHostSnapshot = useHostRuntimeSnapshot(activeServerId ?? "");
  const activeHostStatus = activeServerId
    ? (activeHostSnapshot?.connectionStatus ?? "connecting")
    : "idle";
  let activeHostStatusColor: string;
  if (activeHostStatus === "online") activeHostStatusColor = theme.colors.palette.green[400];
  else if (activeHostStatus === "connecting")
    activeHostStatusColor = theme.colors.palette.amber[500];
  else activeHostStatusColor = theme.colors.palette.red[500];
  const hostOptions = useMemo(
    () =>
      daemons.map((daemon) => ({
        id: daemon.serverId,
        label: daemon.label?.trim() || daemon.serverId,
      })),
    [daemons],
  );
  const renderHostOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => (
      <HostSwitchOption
        serverId={option.id}
        label={option.label}
        selected={selected}
        active={active}
        onPress={onPress}
      />
    ),
    [],
  );
  const hostTriggerRef = useRef<View | null>(null);
  const [isHostPickerOpen, setIsHostPickerOpen] = useState(false);

  const { projects, isInitialLoad, isRevalidating, refreshAll } = useSidebarWorkspacesList({
    serverId: activeServerId,
    enabled: isCompactLayout || isOpen,
  });
  const { collapsedProjectKeys, shortcutIndexByWorkspaceKey, toggleProjectCollapsed } =
    useSidebarShortcutModel({ projects, isInitialLoad });

  const groupMode = useSidebarViewStore((state) =>
    activeServerId ? state.getGroupMode(activeServerId) : "project",
  );

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

  const openProjectPicker = useOpenProjectPicker(activeServerId);

  const handleOpenProjectMobile = useCallback(() => {
    showMobileAgent();
    void openProjectPicker();
  }, [showMobileAgent, openProjectPicker]);

  const handleOpenProjectDesktop = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleNewWorkspaceNavigate = useCallback(() => {
    if (!activeServerId) return;
    router.navigate(buildHostNewWorkspaceRoute(activeServerId));
  }, [activeServerId]);

  const handleSettingsMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsRoute());
  }, [showMobileAgent]);

  const handleSettingsDesktop = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);

  const handleHomeMobile = useCallback(() => {
    if (!activeServerId) return;
    showMobileAgent();
    router.push(buildHostOpenProjectRoute(activeServerId));
  }, [activeServerId, showMobileAgent]);

  const handleHomeDesktop = useCallback(() => {
    if (!activeServerId) return;
    router.push(buildHostOpenProjectRoute(activeServerId));
  }, [activeServerId]);

  const handleViewMoreNavigate = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    router.push(buildHostSessionsRoute(activeServerId));
  }, [activeServerId]);

  const handleHostSelect = useCallback(
    (nextServerId: string) => {
      if (!nextServerId) {
        return;
      }
      const nextPath = mapPathnameToServer(pathname, nextServerId);
      setIsHostPickerOpen(false);
      router.push(nextPath);
    },
    [pathname],
  );

  const labels = useMemo(
    (): SidebarLabels => ({
      addProject: t("sidebar.actions.addProject"),
      newWorkspace: t("sidebar.actions.newWorkspace"),
      home: t("sidebar.actions.home"),
      settings: t("sidebar.actions.settings"),
      switchHost: t("sidebar.host.switchTitle"),
      searchHosts: t("sidebar.host.searchPlaceholder"),
      sessions: t("sidebar.sections.sessions"),
      closeSidebar: t("sidebar.actions.closeSidebar"),
    }),
    [t],
  );

  const sharedProps = {
    theme,
    activeServerId,
    activeHostLabel,
    activeHostStatusColor,
    hostOptions,
    hostTriggerRef,
    isHostPickerOpen,
    setIsHostPickerOpen,
    projects,
    isInitialLoad,
    isRevalidating,
    isManualRefresh,
    groupMode,
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    handleHostSelect,
    renderHostOption,
    labels,
  };

  if (isCompactLayout) {
    return (
      <MobileSidebar
        {...sharedProps}
        insetsTop={insets.top}
        insetsBottom={insets.bottom}
        isOpen={isOpen}
        closeSidebar={showMobileAgent}
        handleNewWorkspaceNavigate={handleNewWorkspaceNavigate}
        handleOpenProject={handleOpenProjectMobile}
        handleHome={handleHomeMobile}
        handleSettings={handleSettingsMobile}
        handleViewMoreNavigate={handleViewMoreNavigate}
      />
    );
  }

  return (
    <DesktopSidebar
      {...sharedProps}
      insetsTop={insets.top}
      isOpen={isOpen}
      handleNewWorkspaceNavigate={handleNewWorkspaceNavigate}
      handleOpenProject={handleOpenProjectDesktop}
      handleHome={handleHomeDesktop}
      handleSettings={handleSettingsDesktop}
      handleViewMore={handleViewMoreNavigate}
    />
  );
});

interface HostPickerTriggerProps {
  triggerRef: React.Ref<View>;
  setIsHostPickerOpen: Dispatch<SetStateAction<boolean>>;
  hostOptionsEmpty: boolean;
  hostStatusDotStyle: StyleProp<ViewStyle>;
  activeHostLabel: string;
}

function HostPickerTrigger({
  triggerRef,
  setIsHostPickerOpen,
  hostOptionsEmpty,
  hostStatusDotStyle,
  activeHostLabel,
}: HostPickerTriggerProps) {
  const pressableStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.hostTrigger,
      hovered && styles.hostTriggerHovered,
    ],
    [],
  );
  const handlePress = useCallback(() => setIsHostPickerOpen(true), [setIsHostPickerOpen]);
  return (
    <Pressable
      ref={triggerRef}
      style={pressableStyle}
      onPress={handlePress}
      disabled={hostOptionsEmpty}
    >
      <View style={hostStatusDotStyle} />
      <Text style={styles.hostTriggerText} numberOfLines={1}>
        {activeHostLabel}
      </Text>
    </Pressable>
  );
}

function HostSwitchOption({
  serverId,
  label,
  selected,
  active,
  onPress,
}: {
  serverId: string;
  label: string;
  selected: boolean;
  active: boolean;
  onPress: () => void;
}) {
  const snapshot = useHostRuntimeSnapshot(serverId);
  const connectionStatus = snapshot?.connectionStatus ?? "connecting";

  return (
    <ComboboxItem
      label={label}
      description={formatConnectionStatus(connectionStatus)}
      selected={selected}
      active={active}
      onPress={onPress}
    />
  );
}

function FooterIconButton({
  onPress,
  testID,
  accessibilityLabel,
  icon: Icon,
  theme,
}: {
  onPress: () => void;
  testID: string;
  accessibilityLabel: string;
  icon: typeof FolderPlus;
  theme: SidebarTheme;
}) {
  return (
    <Pressable
      style={styles.footerIconButton}
      testID={testID}
      nativeID={testID}
      collapsable={false}
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
    >
      {({ hovered }) => (
        <Icon
          size={theme.iconSize.md}
          color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      )}
    </Pressable>
  );
}

function AddProjectTooltipContent({
  newAgentKeys,
  label,
}: {
  newAgentKeys: ReturnType<typeof useShortcutKeys>;
  label: string;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {newAgentKeys ? <Shortcut chord={newAgentKeys} /> : null}
    </View>
  );
}

function HeaderIconTooltipContent({
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
  theme,
  activeServerId,
  activeHostLabel,
  hostStatusDotStyle,
  hostOptions,
  hostTriggerRef,
  isHostPickerOpen,
  setIsHostPickerOpen,
  handleHostSelect,
  renderHostOption,
  handleOpenProject,
  handleHome,
  handleSettings,
  labels,
}: {
  theme: SidebarTheme;
  activeServerId: string | null;
  activeHostLabel: string;
  hostStatusDotStyle: StyleProp<ViewStyle>;
  hostOptions: ComboboxOption[];
  hostTriggerRef: RefObject<View | null>;
  isHostPickerOpen: boolean;
  setIsHostPickerOpen: Dispatch<SetStateAction<boolean>>;
  handleHostSelect: (nextServerId: string) => void;
  renderHostOption: SidebarSharedProps["renderHostOption"];
  handleOpenProject: () => void;
  handleHome: () => void;
  handleSettings: () => void;
  labels: {
    addProject: string;
    home: string;
    settings: string;
    switchHost: string;
    searchHosts: string;
  };
}) {
  const newAgentKeys = useShortcutKeys("new-agent");
  return (
    <View style={styles.sidebarFooter}>
      <View style={styles.footerHostSlot}>
        <HostPickerTrigger
          triggerRef={hostTriggerRef}
          setIsHostPickerOpen={setIsHostPickerOpen}
          hostOptionsEmpty={hostOptions.length === 0}
          hostStatusDotStyle={hostStatusDotStyle}
          activeHostLabel={activeHostLabel}
        />
      </View>
      <View style={styles.footerIconRow}>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <FooterIconButton
              onPress={handleOpenProject}
              testID="sidebar-add-project"
              accessibilityLabel={labels.addProject}
              icon={FolderPlus}
              theme={theme}
            />
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <AddProjectTooltipContent newAgentKeys={newAgentKeys} label={labels.addProject} />
          </TooltipContent>
        </Tooltip>
        <FooterIconButton
          onPress={handleHome}
          testID="sidebar-home"
          accessibilityLabel={labels.home}
          icon={Home}
          theme={theme}
        />
        <FooterIconButton
          onPress={handleSettings}
          testID="sidebar-settings"
          accessibilityLabel={labels.settings}
          icon={Settings}
          theme={theme}
        />
      </View>
      <Combobox
        options={hostOptions}
        value={activeServerId ?? ""}
        onSelect={handleHostSelect}
        renderOption={renderHostOption}
        searchable={false}
        title={labels.switchHost}
        searchPlaceholder={labels.searchHosts}
        desktopMinWidth={280}
        open={isHostPickerOpen}
        onOpenChange={setIsHostPickerOpen}
        anchorRef={hostTriggerRef}
      />
    </View>
  );
}

function MobileSidebar({
  theme,
  activeServerId,
  activeHostLabel,
  activeHostStatusColor,
  hostOptions,
  hostTriggerRef,
  isHostPickerOpen,
  setIsHostPickerOpen,
  projects,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleHostSelect,
  renderHostOption,
  handleNewWorkspaceNavigate,
  handleOpenProject,
  handleHome,
  handleSettings,
  labels,
  insetsTop,
  insetsBottom,
  isOpen,
  closeSidebar,
  handleViewMoreNavigate,
}: MobileSidebarProps) {
  const pathname = usePathname();
  const isSessionsActive = pathname.includes("/sessions");
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    overlayVisible,
    isGesturing,
    mobilePanelState,
    gestureAnimatingRef,
    closeGestureRef,
  } = useSidebarAnimation();
  const closeTouchStartX = useSharedValue(0);
  const closeTouchStartY = useSharedValue(0);

  const handleCloseFromGesture = useCallback(() => {
    gestureAnimatingRef.current = true;
    closeSidebar();
  }, [closeSidebar, gestureAnimatingRef]);

  const handleViewMore = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    translateX.value = -windowWidth;
    backdropOpacity.value = 0;
    closeSidebar();
    handleViewMoreNavigate();
  }, [
    activeServerId,
    backdropOpacity,
    closeSidebar,
    handleViewMoreNavigate,
    translateX,
    windowWidth,
  ]);

  const handleWorkspacePress = useCallback(() => {
    closeSidebar();
  }, [closeSidebar]);

  const handleNewWorkspace = useCallback(() => {
    closeSidebar();
    handleNewWorkspaceNavigate();
  }, [closeSidebar, handleNewWorkspaceNavigate]);

  const closeGesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(closeGestureRef)
        .enabled(true)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (!touch) {
            return;
          }
          closeTouchStartX.value = touch.absoluteX;
          closeTouchStartY.value = touch.absoluteY;
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }

          const deltaX = touch.absoluteX - closeTouchStartX.value;
          const deltaY = touch.absoluteY - closeTouchStartY.value;
          const absDeltaX = Math.abs(deltaX);
          const absDeltaY = Math.abs(deltaY);

          if (!canCloseLeftSidebarGesture(mobilePanelState.value)) {
            stateManager.fail();
            return;
          }

          if (deltaX >= 10) {
            stateManager.fail();
            return;
          }
          if (absDeltaY > 10 && absDeltaY > absDeltaX) {
            stateManager.fail();
            return;
          }
          if (deltaX <= -15 && absDeltaX > absDeltaY) {
            stateManager.activate();
          }
        })
        .onStart(() => {
          isGesturing.value = true;
        })
        .onUpdate((event) => {
          const newTranslateX = Math.min(0, Math.max(-windowWidth, event.translationX));
          translateX.value = newTranslateX;
          backdropOpacity.value = interpolate(
            newTranslateX,
            [-windowWidth, 0],
            [0, 1],
            Extrapolation.CLAMP,
          );
        })
        .onEnd((event) => {
          isGesturing.value = false;
          const shouldClose = event.translationX < -windowWidth / 3 || event.velocityX < -500;
          if (shouldClose) {
            animateToClose();
            runOnJS(handleCloseFromGesture)();
          } else {
            animateToOpen();
          }
        })
        .onFinalize(() => {
          isGesturing.value = false;
        }),
    [
      closeGestureRef,
      closeTouchStartX,
      closeTouchStartY,
      isGesturing,
      mobilePanelState,
      windowWidth,
      translateX,
      backdropOpacity,
      animateToClose,
      animateToOpen,
      handleCloseFromGesture,
    ],
  );

  const mobileSidebarInsetStyle = useMemo(
    () => ({ width: windowWidth, paddingTop: insetsTop, paddingBottom: insetsBottom }),
    [windowWidth, insetsTop, insetsBottom],
  );

  const hostStatusDotStyle = useMemo(
    () => [styles.hostStatusDot, { backgroundColor: activeHostStatusColor }],
    [activeHostStatusColor],
  );

  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  let overlayPointerEvents: "auto" | "none" | "box-none";
  if (!isWeb) overlayPointerEvents = "box-none";
  else if (isOpen) overlayPointerEvents = "auto";
  else overlayPointerEvents = "none";

  const backdropStyle = useMemo(
    () => [
      staticStyles.backdrop,
      backdropAnimatedStyle,
      // pointerEvents is React-owned, not worklet-owned: Reanimated never
      // touches it, so a stale animated-prop revert can't wedge an invisible
      // tap-eating backdrop.
      { pointerEvents: isOpen ? ("auto" as const) : ("none" as const) },
    ],
    [backdropAnimatedStyle, isOpen],
  );
  const mobileSidebarStyle = useMemo(
    () => [
      staticStyles.mobileSidebar,
      mobileSidebarInsetStyle,
      sidebarAnimatedStyle,
      { backgroundColor: theme.colors.surfaceSidebar },
    ],
    [mobileSidebarInsetStyle, sidebarAnimatedStyle, theme.colors.surfaceSidebar],
  );
  // display is React-owned on the plain wrapper View (no animated styles), so
  // a hidden overlay stays hidden no matter what Reanimated's Fabric overlay
  // reverts the panel transform to after a heavy commit (reanimated#9635).
  const overlayStyle = useMemo(
    () => [
      StyleSheet.absoluteFillObject,
      { display: overlayVisible ? ("flex" as const) : ("none" as const) },
    ],
    [overlayVisible],
  );

  return (
    <View style={overlayStyle} pointerEvents={overlayPointerEvents}>
      <Animated.View style={backdropStyle} />

      <GestureDetector gesture={closeGesture} touchAction="pan-y">
        <Animated.View style={mobileSidebarStyle} pointerEvents="auto">
          <View style={styles.sidebarContent} pointerEvents="auto">
            <View style={styles.sidebarHeaderGroup}>
              <SidebarHeaderRow
                icon={Plus}
                label={labels.newWorkspace}
                onPress={handleNewWorkspace}
                testID="sidebar-global-new-workspace"
                variant="compact"
              />
              <SidebarHeaderRow
                icon={Clock}
                label={labels.sessions}
                onPress={handleViewMore}
                isActive={isSessionsActive}
                testID="sidebar-sessions"
                variant="compact"
              />
            </View>
            <WorkspacesSectionHeader
              serverId={activeServerId}
              onNewWorkspacePress={handleNewWorkspace}
            />
            <Pressable
              style={styles.mobileCloseButton}
              onPress={closeSidebar}
              testID="sidebar-close"
              nativeID="sidebar-close"
              accessible
              accessibilityRole="button"
              accessibilityLabel={labels.closeSidebar}
              hitSlop={8}
            >
              {({ hovered, pressed }) => (
                <X
                  size={theme.iconSize.md}
                  color={
                    hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted
                  }
                />
              )}
            </Pressable>

            {isInitialLoad ? (
              <SidebarAgentListSkeleton />
            ) : (
              <SidebarWorkspaceList
                serverId={activeServerId}
                collapsedProjectKeys={collapsedProjectKeys}
                onToggleProjectCollapsed={toggleProjectCollapsed}
                shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
                groupMode={groupMode}
                projects={projects}
                isRefreshing={isManualRefresh && isRevalidating}
                onRefresh={handleRefresh}
                onWorkspacePress={handleWorkspacePress}
                onAddProject={handleOpenProject}
                parentGestureRef={closeGestureRef}
              />
            )}

            <SidebarFooter
              theme={theme}
              activeServerId={activeServerId}
              activeHostLabel={activeHostLabel}
              hostStatusDotStyle={hostStatusDotStyle}
              hostOptions={hostOptions}
              hostTriggerRef={hostTriggerRef}
              isHostPickerOpen={isHostPickerOpen}
              setIsHostPickerOpen={setIsHostPickerOpen}
              handleHostSelect={handleHostSelect}
              renderHostOption={renderHostOption}
              handleOpenProject={handleOpenProject}
              handleHome={handleHome}
              handleSettings={handleSettings}
              labels={labels}
            />
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function DesktopSidebar({
  theme,
  activeServerId,
  activeHostLabel,
  activeHostStatusColor,
  hostOptions,
  hostTriggerRef,
  isHostPickerOpen,
  setIsHostPickerOpen,
  projects,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleHostSelect,
  renderHostOption,
  handleNewWorkspaceNavigate,
  handleOpenProject,
  handleHome,
  handleSettings,
  labels,
  insetsTop,
  isOpen,
  handleViewMore,
}: DesktopSidebarProps) {
  const pathname = usePathname();
  const isSessionsActive = pathname.includes("/sessions");
  const padding = useWindowControlsPadding("sidebar");
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const hostStatusDotStyle = useMemo(
    () => [styles.hostStatusDot, { backgroundColor: activeHostStatusColor }],
    [activeHostStatusColor],
  );

  const startWidthRef = useRef(sidebarWidth);
  const resizeWidth = useSharedValue(sidebarWidth);

  useEffect(() => {
    resizeWidth.value = sidebarWidth;
  }, [sidebarWidth, resizeWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = sidebarWidth;
          resizeWidth.value = sidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidthRef.current + event.translationX;
          const maxWidth = Math.max(
            MIN_SIDEBAR_WIDTH,
            Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - MIN_CHAT_WIDTH),
          );
          const clampedWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, newWidth));
          resizeWidth.value = clampedWidth;
        })
        .onEnd(() => {
          runOnJS(setSidebarWidth)(resizeWidth.value);
        }),
    [sidebarWidth, resizeWidth, setSidebarWidth, viewportWidth],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  const paddingTopSpacerStyle = useMemo(() => ({ height: padding.top }), [padding.top]);
  const desktopSidebarStyle = useMemo(
    () => [staticStyles.desktopSidebar, resizeAnimatedStyle],
    [resizeAnimatedStyle],
  );
  const desktopSidebarBorderStyle = useMemo(
    () => [styles.desktopSidebarBorder, { flex: 1, paddingTop: insetsTop }],
    [insetsTop],
  );
  const resizeHandleStyle = useMemo(
    () => [styles.resizeHandle, isWeb && ({ cursor: "col-resize" } as object)],
    [],
  );

  if (!isOpen) {
    return null;
  }

  return (
    <Animated.View style={desktopSidebarStyle}>
      <View style={desktopSidebarBorderStyle}>
        <View style={styles.sidebarDragArea}>
          <TitlebarDragRegion />
          {padding.top > 0 ? <View style={paddingTopSpacerStyle} /> : null}
          <View style={styles.sidebarHeaderGroup}>
            <SidebarHeaderRow
              icon={Plus}
              label={labels.newWorkspace}
              onPress={handleNewWorkspaceNavigate}
              testID="sidebar-global-new-workspace"
              variant="compact"
            />
            <SidebarHeaderRow
              icon={Clock}
              label={labels.sessions}
              onPress={handleViewMore}
              isActive={isSessionsActive}
              testID="sidebar-sessions"
              variant="compact"
            />
          </View>
        </View>
        <WorkspacesSectionHeader
          serverId={activeServerId}
          onNewWorkspacePress={handleNewWorkspaceNavigate}
        />

        {isInitialLoad ? (
          <SidebarAgentListSkeleton />
        ) : (
          <SidebarWorkspaceList
            serverId={activeServerId}
            collapsedProjectKeys={collapsedProjectKeys}
            onToggleProjectCollapsed={toggleProjectCollapsed}
            shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
            groupMode={groupMode}
            projects={projects}
            isRefreshing={isManualRefresh && isRevalidating}
            onRefresh={handleRefresh}
            onAddProject={handleOpenProject}
          />
        )}

        <SidebarCalloutSlot />

        <SidebarFooter
          theme={theme}
          activeServerId={activeServerId}
          activeHostLabel={activeHostLabel}
          hostStatusDotStyle={hostStatusDotStyle}
          hostOptions={hostOptions}
          hostTriggerRef={hostTriggerRef}
          isHostPickerOpen={isHostPickerOpen}
          setIsHostPickerOpen={setIsHostPickerOpen}
          handleHostSelect={handleHostSelect}
          renderHostOption={renderHostOption}
          handleOpenProject={handleOpenProject}
          handleHome={handleHome}
          handleSettings={handleSettings}
          labels={labels}
        />

        {/* Resize handle - absolutely positioned over right border */}
        <GestureDetector gesture={resizeGesture}>
          <View style={resizeHandleStyle} />
        </GestureDetector>
      </View>
    </Animated.View>
  );
}

function WorkspacesSectionHeader({
  serverId,
  onNewWorkspacePress,
}: {
  serverId: string | null;
  onNewWorkspacePress: () => void;
}) {
  const { theme } = useUnistyles();
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const commandCenterKeys = useShortcutKeys("toggle-command-center");
  const handleSearchPress = useCallback(() => setCommandCenterOpen(true), [setCommandCenterOpen]);
  const searchButtonStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.workspacesHeaderIconButton,
      (hovered || pressed) && styles.workspacesHeaderIconButtonHovered,
    ],
    [],
  );

  return (
    <View style={styles.workspacesSectionHeader}>
      <Text style={styles.workspacesSectionTitle}>Workspaces</Text>
      <View style={styles.workspacesSectionActions}>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New workspace"
              testID="sidebar-new-workspace"
              style={searchButtonStyle}
              onPress={onNewWorkspacePress}
            >
              {({ hovered, pressed }) => (
                <Plus
                  size={14}
                  color={
                    hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted
                  }
                />
              )}
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <HeaderIconTooltipContent label="New workspace" />
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open command center"
              testID="sidebar-command-center-search"
              style={searchButtonStyle}
              onPress={handleSearchPress}
            >
              {({ hovered, pressed }) => (
                <Search
                  size={14}
                  color={
                    hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted
                  }
                />
              )}
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <HeaderIconTooltipContent label="Search" shortcutKeys={commandCenterKeys} />
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <View>
              <SidebarGroupingSelector serverId={serverId} />
            </View>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <HeaderIconTooltipContent label="Display preferences" />
          </TooltipContent>
        </Tooltip>
      </View>
    </View>
  );
}

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  backdrop: {
    ...RNStyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  mobileSidebar: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    bottom: 0,
    overflow: "hidden" as const,
  },
  desktopSidebar: {
    position: "relative" as const,
  },
});

const styles = StyleSheet.create((theme) => ({
  sidebarHeaderGroup: {
    paddingTop: theme.spacing[2],
    // Match WorkspacesSectionHeader's paddingTop below the divider so the divider
    // sits visually centered between the Sessions row and the Workspaces header.
    paddingBottom: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  workspacesSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2] + theme.spacing[3],
    paddingRight: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  workspacesSectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  workspacesSectionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  workspacesHeaderIconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  workspacesHeaderIconButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  mobileCloseButton: {
    position: "absolute",
    top: theme.spacing[3],
    right: theme.spacing[4],
    zIndex: 2,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  desktopSidebarBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  resizeHandle: {
    position: "absolute",
    right: -5,
    top: 0,
    bottom: 0,
    width: 10,
    zIndex: 10,
  },
  sidebarDragArea: {
    position: "relative",
  },
  hostTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: theme.spacing[2],
    minWidth: 0,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  hostTriggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  hostStatusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  hostTriggerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
  },
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerHostSlot: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
    marginRight: theme.spacing[2],
  },
  footerIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  footerIconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  hostPickerList: {
    gap: theme.spacing[2],
  },
  hostPickerOption: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  hostPickerOptionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  hostPickerCancel: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
  },
  hostPickerCancelText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
