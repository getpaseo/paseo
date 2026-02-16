import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { View, Pressable, Text, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { Plus, Settings, Users } from "lucide-react-native";
import { router, usePathname } from "expo-router";
import { usePanelStore } from "@/stores/panel-store";
import { SidebarAgentList } from "./sidebar-agent-list";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { useSidebarAgentsGrouped } from "@/hooks/use-sidebar-agents-grouped";
import { useSidebarAnimation } from "@/contexts/sidebar-animation-context";
import { useTauriDragHandlers, useTrafficLightPadding } from "@/utils/tauri-window";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { Combobox } from "@/components/ui/combobox";
import { useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import { formatConnectionStatus } from "@/utils/daemons";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import {
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
} from "@/hooks/use-checkout-status-query";
import { queryClient } from "@/query/query-client";
import {
  buildNewAgentRoute,
  resolveNewAgentWorkingDir,
  resolveSelectedAgentForNewAgent,
} from "@/utils/new-agent-routing";
import {
  buildHostAgentsRoute,
  buildHostSettingsRoute,
  mapPathnameToServer,
  parseServerIdFromPathname,
} from "@/utils/host-routes";

const DESKTOP_SIDEBAR_WIDTH = 320;

interface SlidingSidebarProps {
  selectedAgentId?: string;
}

export function SlidingSidebar({ selectedAgentId }: SlidingSidebarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const pathname = usePathname();
  const { daemons } = useDaemonRegistry();
  const { connectionStates } = useDaemonConnections();
  const activeServerIdFromPath = useMemo(
    () => parseServerIdFromPathname(pathname),
    [pathname]
  );
  const activeServerId = activeServerIdFromPath ?? daemons[0]?.serverId ?? null;
  const activeHostLabel = useMemo(() => {
    if (!activeServerId) return "No host";
    const daemon = daemons.find((entry) => entry.serverId === activeServerId);
    const trimmed = daemon?.label?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : activeServerId;
  }, [activeServerId, daemons]);
  const activeHostStatus = activeServerId
    ? (connectionStates.get(activeServerId)?.status ?? "idle")
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
          connectionStates.get(daemon.serverId)?.status ?? "idle"
        ),
      })),
    [connectionStates, daemons]
  );
  const hostTriggerRef = useRef<View>(null);
  const [isHostPickerOpen, setIsHostPickerOpen] = useState(false);

  // Derive isOpen from the unified panel state
  const isOpen = isMobile ? mobileView === "agent-list" : desktopAgentListOpen;
  const [selectedProjectKeys, setSelectedProjectKeys] = useState<string[]>([]);

  const {
    entries,
    projectOptions,
    hasMoreEntries,
    isInitialLoad,
    isRevalidating,
    refreshAll,
  } = useSidebarAgentsGrouped({
    isOpen,
    serverId: activeServerId,
    selectedProjectKeys,
  });
  useEffect(() => {
    setSelectedProjectKeys([]);
  }, [activeServerId]);
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    isGesturing,
    closeGestureRef,
  } = useSidebarAnimation();
  const dragHandlers = useTauriDragHandlers();
  const trafficLightPadding = useTrafficLightPadding();

  // Track user-initiated refresh to avoid showing spinner on background revalidation
  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  // Reset manual refresh flag when revalidation completes
  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const setSidebarShortcutAgentKeys = useKeyboardShortcutsStore(
    (s) => s.setSidebarShortcutAgentKeys
  );
  const sidebarShortcutAgentKeys = useMemo(() => {
    return entries.slice(0, 9).map((entry) => `${entry.agent.serverId}:${entry.agent.id}`);
  }, [entries]);

  useEffect(() => {
    setSidebarShortcutAgentKeys(sidebarShortcutAgentKeys);
  }, [setSidebarShortcutAgentKeys, sidebarShortcutAgentKeys]);

  const handleClose = useCallback(() => {
    closeToAgent();
  }, [closeToAgent]);

  const handleCreateAgentClean = useCallback(() => {
    let targetServerId = activeServerId;
    let targetWorkingDir: string | null = null;

    const selectedAgent = resolveSelectedAgentForNewAgent({
      pathname,
      selectedAgentId,
    });
    if (selectedAgent) {
      targetServerId = selectedAgent.serverId;
      const agent = useSessionStore
        .getState()
        .sessions[selectedAgent.serverId]
        ?.agents?.get(selectedAgent.agentId);
      const cwd = agent?.cwd?.trim();
      if (cwd) {
        const checkout =
          queryClient.getQueryData<CheckoutStatusPayload>(
            checkoutStatusQueryKey(selectedAgent.serverId, cwd)
          ) ?? null;
        targetWorkingDir = resolveNewAgentWorkingDir(cwd, checkout);
      }
    }

    if (!targetServerId) {
      return;
    }
    router.push(buildNewAgentRoute(targetServerId, targetWorkingDir) as any);
  }, [activeServerId, pathname, selectedAgentId]);

  // Mobile: close sidebar and navigate
  const handleCreateAgentCleanMobile = useCallback(() => {
    closeToAgent();
    handleCreateAgentClean();
  }, [closeToAgent, handleCreateAgentClean]);

  // Desktop: just navigate, don't close
  const handleCreateAgentCleanDesktop = useCallback(() => {
    handleCreateAgentClean();
  }, [handleCreateAgentClean]);

  // Mobile: close sidebar and navigate
  const handleSettingsMobile = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    closeToAgent();
    router.push(buildHostSettingsRoute(activeServerId) as any);
  }, [activeServerId, closeToAgent]);

  // Desktop: just navigate, don't close
  const handleSettingsDesktop = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    router.push(buildHostSettingsRoute(activeServerId) as any);
  }, [activeServerId]);

  // Mobile: close sidebar when agent is selected
  // Snap immediately since navigation interrupts animations
  const handleAgentSelectMobile = useCallback(() => {
    translateX.value = -windowWidth;
    backdropOpacity.value = 0;
    closeToAgent();
  }, [closeToAgent, translateX, backdropOpacity, windowWidth]);

  const handleViewMore = useCallback(() => {
    if (!activeServerId) {
      return;
    }
    if (isMobile) {
      translateX.value = -windowWidth;
      backdropOpacity.value = 0;
      closeToAgent();
    }
    router.push(buildHostAgentsRoute(activeServerId) as any);
  }, [
    activeServerId,
    backdropOpacity,
    closeToAgent,
    isMobile,
    translateX,
    windowWidth,
  ]);

  const listFooterComponent = useMemo(() => {
    if (!hasMoreEntries) {
      return null;
    }

    return (
      <Pressable style={styles.listViewMoreButton} onPress={handleViewMore}>
        {({ hovered }) => (
          <Text
            style={[
              styles.listViewMoreButtonText,
              hovered && styles.listViewMoreButtonTextHovered,
            ]}
          >
            View more
          </Text>
        )}
      </Pressable>
    );
  }, [handleViewMore, hasMoreEntries]);

  const handleHostSelect = useCallback(
    (nextServerId: string) => {
      if (!nextServerId) {
        return;
      }
      const nextPath = mapPathnameToServer(pathname, nextServerId);
      setIsHostPickerOpen(false);
      router.push(nextPath as any);
    },
    [pathname]
  );

  // Close gesture (swipe left to close when sidebar is open)
  // Only activates on leftward swipe, fails on rightward or vertical movement
  // This mirrors the explorer-sidebar pattern for the right sidebar
  const closeGesture = Gesture.Pan()
    .withRef(closeGestureRef)
    .enabled(isOpen)
    // Only activate on leftward swipe (negative X)
    .activeOffsetX(-15)
    // Fail on rightward movement (allow internal list scrolling)
    .failOffsetX(10)
    // Fail if vertical movement happens first (allow vertical scroll)
    .failOffsetY([-10, 10])
    .onStart(() => {
      isGesturing.value = true;
    })
    .onUpdate((event) => {
      if (!isMobile) return;
      // Only allow swiping left (closing)
      const newTranslateX = Math.min(0, Math.max(-windowWidth, event.translationX));
      translateX.value = newTranslateX;
      backdropOpacity.value = interpolate(
        newTranslateX,
        [-windowWidth, 0],
        [0, 1],
        Extrapolation.CLAMP
      );
    })
    .onEnd((event) => {
      isGesturing.value = false;
      if (!isMobile) return;
      const shouldClose = event.translationX < -windowWidth / 3 || event.velocityX < -500;
      if (shouldClose) {
        animateToClose();
        runOnJS(handleClose)();
      } else {
        animateToOpen();
      }
    })
    .onFinalize(() => {
      isGesturing.value = false;
    });


  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
    pointerEvents: backdropOpacity.value > 0.01 ? "auto" : "none",
  }));


  // Render mobile sidebar
  // On web, use "auto" instead of "box-none" because web's pointer-events: none blocks scroll
  const overlayPointerEvents = Platform.OS === "web" ? "auto" : "box-none";
  if (isMobile) {
    return (
      <View style={StyleSheet.absoluteFillObject} pointerEvents={overlayPointerEvents}>
        {/* Backdrop */}
        <Animated.View style={[styles.backdrop, backdropAnimatedStyle]}>
          <Pressable style={styles.backdropPressable} onPress={handleClose} />
        </Animated.View>

        <GestureDetector gesture={closeGesture} touchAction="pan-y">
          <Animated.View
            style={[
              styles.mobileSidebar,
              { width: windowWidth, paddingTop: insets.top, paddingBottom: insets.bottom },
              sidebarAnimatedStyle,
            ]}
            pointerEvents="auto"
          >
            <View style={styles.sidebarContent} pointerEvents="auto">
              {/* Header */}
              <View style={styles.sidebarHeader}>
                <View style={styles.sidebarHeaderRow}>
                  <Pressable
                    style={styles.newAgentButton}
                    testID="sidebar-new-agent"
                    onPress={handleCreateAgentCleanMobile}
                  >
                    {({ hovered }) => (
                      <>
                        <Plus size={18} color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
                        <Text style={[styles.newAgentButtonText, hovered && styles.newAgentButtonTextHovered]}>New agent</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              </View>

              {/* Middle: scrollable agent list */}
              {isInitialLoad ? (
                <SidebarAgentListSkeleton />
              ) : (
                <SidebarAgentList
                  entries={entries}
                  projectOptions={projectOptions}
                  selectedProjectKeys={selectedProjectKeys}
                  onSelectedProjectKeysChange={setSelectedProjectKeys}
                  isRefreshing={isManualRefresh && isRevalidating}
                  onRefresh={handleRefresh}
                  listFooterComponent={listFooterComponent}
                  selectedAgentId={selectedAgentId}
                  onAgentSelect={handleAgentSelectMobile}
                  parentGestureRef={closeGestureRef}
                />
              )}

              {/* Footer */}
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
                    <View
                      style={[
                        styles.hostStatusDot,
                        { backgroundColor: activeHostStatusColor },
                      ]}
                    />
                    <Text style={styles.hostTriggerText} numberOfLines={1}>
                      {activeHostLabel}
                    </Text>
                  </Pressable>
                </View>
                <View style={styles.footerIconRow}>
                  <Pressable
                    style={styles.footerIconButton}
                    testID="sidebar-all-agents"
                    nativeID="sidebar-all-agents"
                    collapsable={false}
                    accessible
                    accessibilityLabel="All agents"
                    accessibilityRole="button"
                    onPress={handleViewMore}
                  >
                    {({ hovered }) => (
                      <Users
                        size={20}
                        color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                      />
                    )}
                  </Pressable>
                  <Pressable
                    style={styles.footerIconButton}
                    testID="sidebar-settings"
                    nativeID="sidebar-settings"
                    collapsable={false}
                    accessible
                    accessibilityLabel="Settings"
                    accessibilityRole="button"
                    onPress={handleSettingsMobile}
                  >
                    {({ hovered }) => (
                      <Settings
                        size={20}
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

  // Desktop: no edge swipe, just show/hide based on isOpen
  if (!isOpen) {
    return null;
  }

  return (
    <View style={[styles.desktopSidebar, { width: DESKTOP_SIDEBAR_WIDTH }]}>
      <View
        style={[styles.sidebarHeader, { paddingLeft: theme.spacing[2] + trafficLightPadding.left }]}
        {...dragHandlers}
      >
        <View style={styles.sidebarHeaderRow}>
          <Pressable
            style={styles.newAgentButton}
            testID="sidebar-new-agent"
            onPress={handleCreateAgentCleanDesktop}
          >
            {({ hovered }) => (
              <>
                <Plus size={18} color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
              <Text style={[styles.newAgentButtonText, hovered && styles.newAgentButtonTextHovered]}>New agent</Text>
              </>
            )}
          </Pressable>
        </View>
      </View>

      {/* Middle: scrollable agent list */}
      {isInitialLoad ? (
        <SidebarAgentListSkeleton />
      ) : (
        <SidebarAgentList
          entries={entries}
          projectOptions={projectOptions}
          selectedProjectKeys={selectedProjectKeys}
          onSelectedProjectKeysChange={setSelectedProjectKeys}
          isRefreshing={isManualRefresh && isRevalidating}
          onRefresh={handleRefresh}
          listFooterComponent={listFooterComponent}
          selectedAgentId={selectedAgentId}
        />
      )}

      {/* Footer */}
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
            <View
              style={[
                styles.hostStatusDot,
                { backgroundColor: activeHostStatusColor },
              ]}
            />
            <Text style={styles.hostTriggerText} numberOfLines={1}>
              {activeHostLabel}
            </Text>
          </Pressable>
        </View>
        <View style={styles.footerIconRow}>
          <Pressable
            style={styles.footerIconButton}
            testID="sidebar-all-agents"
            nativeID="sidebar-all-agents"
            collapsable={false}
            accessible
            accessibilityLabel="All agents"
            accessibilityRole="button"
            onPress={handleViewMore}
          >
            {({ hovered }) => (
              <Users
                size={20}
                color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
          <Pressable
            style={styles.footerIconButton}
            testID="sidebar-settings"
            nativeID="sidebar-settings"
            collapsable={false}
            accessible
            accessibilityLabel="Settings"
            accessibilityRole="button"
            onPress={handleSettingsDesktop}
          >
            {({ hovered }) => (
              <Settings size={20} color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
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
  );
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  backdropPressable: {
    flex: 1,
  },
  mobileSidebar: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  desktopSidebar: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
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
    justifyContent: "flex-start",
    gap: theme.spacing[2],
  },
  newAgentButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    flexShrink: 0,
  },
  newAgentButtonHovered: {},
  newAgentButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  newAgentButtonTextHovered: {
    color: theme.colors.foreground,
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
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  hostTriggerHovered: {
    borderColor: theme.colors.borderAccent,
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
  listViewMoreButton: {
    marginTop: theme.spacing[2],
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
  },
  listViewMoreButtonText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  listViewMoreButtonTextHovered: {
    color: theme.colors.foreground,
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
}));
