import {
  memo,
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  View,
  Pressable,
  Text,
  Platform,
  useWindowDimensions,
  StyleSheet as RNStyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  runOnJS,
  useSharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { MessagesSquare, Plus, Settings } from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { router, usePathname } from "expo-router";
import { usePanelStore, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from "@/stores/panel-store";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { useSidebarShortcutModel } from "@/hooks/use-sidebar-shortcut-model";
import {
  useSidebarWorkspacesList,
  type SidebarProjectEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarAnimation } from "@/contexts/sidebar-animation-context";
import { useWindowControlsPadding } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { Combobox } from "@/components/ui/combobox";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { formatConnectionStatus } from "@/utils/daemons";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import {
  buildHostSessionsRoute,
  buildHostSettingsRoute,
  mapPathnameToServer,
  parseServerIdFromPathname,
} from "@/utils/host-routes";
import { useOpenProjectPicker } from "@/hooks/use-open-project-picker";

const MIN_CHAT_WIDTH = 400;

type SidebarShortcutModel = ReturnType<typeof useSidebarShortcutModel>;
type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

interface LeftSidebarProps {
  selectedAgentId?: string;
}

interface HostOption {
  id: string;
  label: string;
  description: string;
}

interface SidebarSharedProps {
  theme: SidebarTheme;
  activeServerId: string | null;
  activeHostLabel: string;
  activeHostStatusColor: string;
  hostOptions: HostOption[];
  hostTriggerRef: RefObject<View | null>;
  isHostPickerOpen: boolean;
  setIsHostPickerOpen: Dispatch<SetStateAction<boolean>>;
  projects: SidebarProjectEntry[];
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  collapsedProjectKeys: SidebarShortcutModel["collapsedProjectKeys"];
  shortcutIndexByWorkspaceKey: SidebarShortcutModel["shortcutIndexByWorkspaceKey"];
  toggleProjectCollapsed: SidebarShortcutModel["toggleProjectCollapsed"];
  handleRefresh: () => void;
  handleHostSelect: (nextServerId: string) => void;
  handleOpenProject: () => void;
  handleSettings: () => void;
}

interface MobileSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  insetsBottom: number;
  isOpen: boolean;
  closeToAgent: () => void;
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
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const pathname = usePathname();
  const daemons = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeConnectionStatusSignature = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () =>
      daemons
        .map(
          (daemon) =>
            `${daemon.serverId}:${
              runtime.getSnapshot(daemon.serverId)?.connectionStatus ?? "connecting"
            }`,
        )
        .join("|"),
    () =>
      daemons
        .map(
          (daemon) =>
            `${daemon.serverId}:${
              runtime.getSnapshot(daemon.serverId)?.connectionStatus ?? "connecting"
            }`,
        )
        .join("|"),
  );
  const activeServerIdFromPath = useMemo(() => parseServerIdFromPathname(pathname), [pathname]);
  const activeDaemon = useMemo(() => {
    if (daemons.length === 0) {
      return null;
    }
    if (activeServerIdFromPath) {
      const routeMatch = daemons.find((entry) => entry.serverId === activeServerIdFromPath);
      if (routeMatch) {
        return routeMatch;
      }
    }
    return daemons[0] ?? null;
  }, [activeServerIdFromPath, daemons]);
  const activeServerId = activeDaemon?.serverId ?? null;
  const activeHostLabel = useMemo(() => {
    if (!activeDaemon) return "No host";
    const trimmed = activeDaemon.label?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : activeDaemon.serverId;
  }, [activeDaemon]);
  const activeHostStatus = activeServerId
    ? (runtime.getSnapshot(activeServerId)?.connectionStatus ?? "connecting")
    : "idle";
  const activeHostStatusColor =
    activeHostStatus === "online"
      ? theme.colors.palette.green[400]
      : activeHostStatus === "connecting"
        ? theme.colors.palette.amber[500]
        : theme.colors.palette.red[500];
  const hostOptions = useMemo(
    () =>
      daemons.map((daemon) => ({
        id: daemon.serverId,
        label: daemon.label?.trim() || daemon.serverId,
        description: formatConnectionStatus(
          runtime.getSnapshot(daemon.serverId)?.connectionStatus ?? "connecting",
        ),
      })),
    [daemons, runtime, runtimeConnectionStatusSignature],
  );
  const hostTriggerRef = useRef<View | null>(null);
  const [isHostPickerOpen, setIsHostPickerOpen] = useState(false);

  const isOpen = isCompactLayout ? mobileView === "agent-list" : desktopAgentListOpen;

  const { projects, isInitialLoad, isRevalidating, refreshAll } = useSidebarWorkspacesList({
    serverId: activeServerId,
    enabled: isOpen,
  });
  const {
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
  } = useSidebarShortcutModel(projects);

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
    closeToAgent();
    void openProjectPicker();
  }, [closeToAgent, openProjectPicker]);

  const handleOpenProjectDesktop = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettingsMobile = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    closeToAgent();
    router.push(buildHostSettingsRoute(activeServerId));
  }, [activeServerId, closeToAgent]);

  const handleSettingsDesktop = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    router.push(buildHostSettingsRoute(activeServerId));
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
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    handleHostSelect,
  };

  if (isCompactLayout) {
    return (
      <MobileSidebar
        {...sharedProps}
        insetsTop={insets.top}
        insetsBottom={insets.bottom}
        isOpen={isOpen}
        closeToAgent={closeToAgent}
        handleOpenProject={handleOpenProjectMobile}
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
      handleOpenProject={handleOpenProjectDesktop}
      handleSettings={handleSettingsDesktop}
      handleViewMore={handleViewMoreNavigate}
    />
  );
});

function SessionsButton({ onPress }: { onPress: () => void }) {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const isActive = pathname.includes("/sessions");

  return (
    <Pressable
      style={({ hovered }) => [
        styles.newAgentButton,
        hovered && styles.newAgentButtonHovered,
        isActive && styles.newAgentButtonActive,
      ]}
      testID="sidebar-sessions"
      accessible
      accessibilityRole="button"
      accessibilityLabel="Sessions"
      onPress={onPress}
    >
      {({ hovered }) => (
        <>
          <MessagesSquare
            size={theme.iconSize.md}
            color={hovered || isActive ? theme.colors.foreground : theme.colors.foregroundMuted}
          />
          <Text
            style={[
              styles.newAgentButtonText,
              (hovered || isActive) && styles.newAgentButtonTextHovered,
            ]}
          >
            Sessions
          </Text>
        </>
      )}
    </Pressable>
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
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleHostSelect,
  handleOpenProject,
  handleSettings,
  insetsTop,
  insetsBottom,
  isOpen,
  closeToAgent,
  handleViewMoreNavigate,
}: MobileSidebarProps) {
  const newAgentKeys = useShortcutKeys("new-agent");
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    isGesturing,
    gestureAnimatingRef,
    closeGestureRef,
  } = useSidebarAnimation();
  const closeTouchStartX = useSharedValue(0);
  const closeTouchStartY = useSharedValue(0);

  const handleCloseFromGesture = useCallback(() => {
    gestureAnimatingRef.current = true;
    closeToAgent();
  }, [closeToAgent, gestureAnimatingRef]);

  const handleViewMore = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    translateX.value = -windowWidth;
    backdropOpacity.value = 0;
    closeToAgent();
    handleViewMoreNavigate();
  }, [
    activeServerId,
    backdropOpacity,
    closeToAgent,
    handleViewMoreNavigate,
    translateX,
    windowWidth,
  ]);

  const closeGesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(closeGestureRef)
        .enabled(isOpen)
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
      isOpen,
      closeGestureRef,
      closeTouchStartX,
      closeTouchStartY,
      isGesturing,
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
    pointerEvents: backdropOpacity.value > 0.01 ? "auto" : "none",
  }));

  const overlayPointerEvents = Platform.OS === "web" ? (isOpen ? "auto" : "none") : "box-none";

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents={overlayPointerEvents}>
      <Animated.View style={[staticStyles.backdrop, backdropAnimatedStyle]} />

      <GestureDetector gesture={closeGesture} touchAction="pan-y">
        <Animated.View
          style={[staticStyles.mobileSidebar, mobileSidebarInsetStyle, sidebarAnimatedStyle, { backgroundColor: theme.colors.surfaceSidebar }]}
          pointerEvents="auto"
        >
          <View style={styles.sidebarContent} pointerEvents="auto">
            <View style={styles.sidebarHeader}>
              <View style={styles.sidebarHeaderRow}>
                <SessionsButton onPress={handleViewMore} />
              </View>
            </View>

            {isInitialLoad ? (
              <SidebarAgentListSkeleton />
            ) : (
              <SidebarWorkspaceList
                serverId={activeServerId}
                collapsedProjectKeys={collapsedProjectKeys}
                onToggleProjectCollapsed={toggleProjectCollapsed}

                shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
                projects={projects}
                isRefreshing={isManualRefresh && isRevalidating}
                onRefresh={handleRefresh}
                onWorkspacePress={() => closeToAgent()}
                onAddProject={handleOpenProject}
                parentGestureRef={closeGestureRef}
              />
            )}

            <View style={styles.sidebarFooter}>
              <View style={styles.footerHostSlot}>
                <Pressable
                  ref={hostTriggerRef}
                  style={({ hovered = false }) => [
                    styles.hostTrigger,
                    hovered && styles.hostTriggerHovered,
                  ]}
                  onPress={() => setIsHostPickerOpen(true)}
                  disabled={hostOptions.length === 0}
                >
                  <View style={hostStatusDotStyle} />
                  <Text style={styles.hostTriggerText} numberOfLines={1}>
                    {activeHostLabel}
                  </Text>
                </Pressable>
              </View>
              <View style={styles.footerIconRow}>
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <Pressable
                      style={styles.footerIconButton}
                      testID="sidebar-add-project"
                      nativeID="sidebar-add-project"
                      collapsable={false}
                      accessible
                      accessibilityLabel="Add project"
                      accessibilityRole="button"
                      onPress={handleOpenProject}
                    >
                      {({ hovered }) => (
                        <Plus
                          size={theme.iconSize.md}
                          color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                        />
                      )}
                    </Pressable>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="center" offset={8}>
                    <View style={styles.tooltipRow}>
                      <Text style={styles.tooltipText}>Add project</Text>
                      {newAgentKeys ? <Shortcut chord={newAgentKeys} /> : null}
                    </View>
                  </TooltipContent>
                </Tooltip>
                <Pressable
                  style={styles.footerIconButton}
                  testID="sidebar-settings"
                  nativeID="sidebar-settings"
                  collapsable={false}
                  accessible
                  accessibilityLabel="Settings"
                  accessibilityRole="button"
                  onPress={handleSettings}
                >
                  {({ hovered }) => (
                    <Settings
                      size={theme.iconSize.md}
                      color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                    />
                  )}
                </Pressable>
              </View>
              <Combobox
                options={hostOptions}
                value={activeServerId ?? ""}
                onSelect={handleHostSelect}
                searchable={false}
                title="Switch host"
                searchPlaceholder="Search hosts..."
                open={isHostPickerOpen}
                onOpenChange={setIsHostPickerOpen}
                anchorRef={hostTriggerRef}
              />
            </View>
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
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  handleHostSelect,
  handleOpenProject,
  handleSettings,
  insetsTop,
  isOpen,
  handleViewMore,
}: DesktopSidebarProps) {
  const newAgentKeys = useShortcutKeys("new-agent");
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

  if (!isOpen) {
    return null;
  }

  return (
    <Animated.View style={[staticStyles.desktopSidebar, resizeAnimatedStyle, { paddingTop: insetsTop }]}>
      <View style={[styles.desktopSidebarBorder, { flex: 1 }]}>
      <View style={styles.sidebarDragArea}>
        <TitlebarDragRegion />
        {padding.top > 0 ? <View style={{ height: padding.top }} /> : null}
        <View style={styles.sidebarHeader}>
          <View style={styles.sidebarHeaderRow}>
            <SessionsButton onPress={handleViewMore} />
          </View>
        </View>
      </View>

      {isInitialLoad ? (
        <SidebarAgentListSkeleton />
      ) : (
        <SidebarWorkspaceList
          serverId={activeServerId}
          collapsedProjectKeys={collapsedProjectKeys}
          onToggleProjectCollapsed={toggleProjectCollapsed}
          shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
          projects={projects}
          isRefreshing={isManualRefresh && isRevalidating}
          onRefresh={handleRefresh}
          onAddProject={handleOpenProject}
        />
      )}

      <View style={styles.sidebarFooter}>
        <View style={styles.footerHostSlot}>
          <Pressable
            ref={hostTriggerRef}
            style={({ hovered = false }) => [
              styles.hostTrigger,
              hovered && styles.hostTriggerHovered,
            ]}
            onPress={() => setIsHostPickerOpen(true)}
            disabled={hostOptions.length === 0}
          >
            <View style={hostStatusDotStyle} />
            <Text style={styles.hostTriggerText} numberOfLines={1}>
              {activeHostLabel}
            </Text>
          </Pressable>
        </View>
        <View style={styles.footerIconRow}>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Pressable
                style={styles.footerIconButton}
                testID="sidebar-add-project"
                nativeID="sidebar-add-project"
                collapsable={false}
                accessible
                accessibilityLabel="Add project"
                accessibilityRole="button"
                onPress={handleOpenProject}
              >
                {({ hovered }) => (
                  <Plus
                    size={theme.iconSize.md}
                    color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                  />
                )}
              </Pressable>
            </TooltipTrigger>
            <TooltipContent side="top" align="center" offset={8}>
              <View style={styles.tooltipRow}>
                <Text style={styles.tooltipText}>Add project</Text>
                {newAgentKeys ? <Shortcut chord={newAgentKeys} /> : null}
              </View>
            </TooltipContent>
          </Tooltip>
          <Pressable
            style={styles.footerIconButton}
            testID="sidebar-settings"
            nativeID="sidebar-settings"
            collapsable={false}
            accessible
            accessibilityLabel="Settings"
            accessibilityRole="button"
            onPress={handleSettings}
          >
            {({ hovered }) => (
              <Settings
                size={theme.iconSize.md}
                color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        </View>
        <Combobox
          options={hostOptions}
          value={activeServerId ?? ""}
          onSelect={handleHostSelect}
          searchable={false}
          title="Switch host"
          searchPlaceholder="Search hosts..."
          open={isHostPickerOpen}
          onOpenChange={setIsHostPickerOpen}
          anchorRef={hostTriggerRef}
        />
      </View>

      {/* Resize handle - absolutely positioned over right border */}
      <GestureDetector gesture={resizeGesture}>
        <View
          style={[styles.resizeHandle, Platform.OS === "web" && ({ cursor: "col-resize" } as any)]}
        />
      </GestureDetector>
      </View>
    </Animated.View>
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
  sidebarContent: {
    flex: 1,
    minHeight: 0,
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
  sidebarHeader: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  sidebarHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  newAgentButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  newAgentButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  newAgentButtonTextHovered: {
    color: theme.colors.foreground,
  },
  newAgentButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  newAgentButtonActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
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
