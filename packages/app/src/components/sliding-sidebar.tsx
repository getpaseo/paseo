import { useCallback, useMemo, useState, useEffect } from "react";
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
import { router } from "expo-router";
import { usePanelStore } from "@/stores/panel-store";
import { GroupedAgentList } from "./grouped-agent-list";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useSidebarAnimation } from "@/contexts/sidebar-animation-context";
import { useTauriDragHandlers, useTrafficLightPadding } from "@/utils/tauri-window";

const DESKTOP_SIDEBAR_WIDTH = 320;
const SIDEBAR_AGENT_LIMIT = 15;

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

  // Derive isOpen from the unified panel state
  const isOpen = isMobile ? mobileView === "agent-list" : desktopAgentListOpen;

  const { agents, isRevalidating, refreshAll } = useAggregatedAgents();
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    isGesturing,
    closeGestureRef,
  } = useSidebarAnimation();
  const trafficLightPadding = useTrafficLightPadding();
  const dragHandlers = useTauriDragHandlers();

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

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      if (a.requiresAttention && !b.requiresAttention) return -1;
      if (!a.requiresAttention && b.requiresAttention) return 1;
      return 0;
    });
  }, [agents]);

  const limitedAgents = useMemo(
    () => sortedAgents.slice(0, SIDEBAR_AGENT_LIMIT),
    [sortedAgents]
  );

  const handleClose = useCallback(() => {
    closeToAgent();
  }, [closeToAgent]);

  const handleCreateAgentClean = useCallback(() => {
    router.push("/agent" as any);
  }, []);

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
    closeToAgent();
    router.push("/settings");
  }, [closeToAgent]);

  // Desktop: just navigate, don't close
  const handleSettingsDesktop = useCallback(() => {
    router.push("/settings");
  }, []);

  // Mobile: close sidebar when agent is selected
  // Snap immediately since navigation interrupts animations
  const handleAgentSelectMobile = useCallback(() => {
    translateX.value = -windowWidth;
    backdropOpacity.value = 0;
    closeToAgent();
  }, [closeToAgent, translateX, backdropOpacity, windowWidth]);

  const handleViewMore = useCallback(() => {
    if (isMobile) {
      translateX.value = -windowWidth;
      backdropOpacity.value = 0;
    }
    closeToAgent();
    router.push("/agents");
  }, [backdropOpacity, closeToAgent, isMobile, translateX, windowWidth]);

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
                <Pressable
                  style={({ hovered }) => [
                    styles.newAgentButton,
                    hovered && styles.newAgentButtonHovered,
                  ]}
                  testID="sidebar-new-agent"
                  onPress={handleCreateAgentCleanMobile}
                >
                  <Plus size={18} color={theme.colors.foreground} />
                  <Text style={styles.newAgentButtonText}>New Agent</Text>
                </Pressable>
              </View>

              {/* Middle: scrollable agent list */}
              <GroupedAgentList
                agents={limitedAgents}
                isRefreshing={isManualRefresh && isRevalidating}
                onRefresh={handleRefresh}
                selectedAgentId={selectedAgentId}
                onAgentSelect={handleAgentSelectMobile}
                parentGestureRef={closeGestureRef}
              />

              {/* Footer */}
              <View style={styles.sidebarFooter}>
                <Pressable
                  style={styles.footerButton}
                  onPress={handleViewMore}
                >
                  {({ hovered }) => (
                    <>
                      <Users size={18} color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
                      <Text style={[styles.footerButtonText, hovered && styles.footerButtonTextHovered]}>
                        All agents
                      </Text>
                    </>
                  )}
                </Pressable>
                <Pressable
                  style={styles.footerIconButton}
                  onPress={handleSettingsMobile}
                >
                  {({ hovered }) => (
                    <Settings size={20} color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
                  )}
                </Pressable>
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
      {/* Header: New Agent button - top padding area is draggable on Tauri */}
      <View
        style={[styles.sidebarHeader, { paddingTop: trafficLightPadding.top || styles.sidebarHeader.paddingTop }]}
        {...dragHandlers}
      >
        <Pressable
          style={({ hovered }) => [
            styles.newAgentButton,
            hovered && styles.newAgentButtonHovered,
          ]}
          testID="sidebar-new-agent"
          onPress={handleCreateAgentCleanDesktop}
        >
          <Plus size={18} color={theme.colors.foreground} />
          <Text style={styles.newAgentButtonText}>New Agent</Text>
        </Pressable>
      </View>

      {/* Middle: scrollable agent list */}
      <GroupedAgentList
        agents={limitedAgents}
        isRefreshing={isManualRefresh && isRevalidating}
        onRefresh={handleRefresh}
        selectedAgentId={selectedAgentId}
      />

      {/* Footer */}
      <View style={styles.sidebarFooter}>
        <Pressable
          style={styles.footerButton}
          onPress={handleViewMore}
        >
          {({ hovered }) => (
            <>
              <Users size={18} color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
              <Text style={[styles.footerButtonText, hovered && styles.footerButtonTextHovered]}>
                All agents
              </Text>
            </>
          )}
        </Pressable>
        <Pressable
          style={styles.footerIconButton}
          onPress={handleSettingsDesktop}
        >
          {({ hovered }) => (
            <Settings size={20} color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
          )}
        </Pressable>
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
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    userSelect: "none",
  },
  newAgentButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    transitionProperty: "border-color, background-color",
    transitionDuration: "150ms",
  },
  newAgentButtonHovered: {
    borderColor: theme.colors.palette.zinc[500],
    backgroundColor: theme.colors.surface2,
  },
  newAgentButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
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
  footerButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  footerIconButton: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  footerButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  footerButtonTextHovered: {
    color: theme.colors.foreground,
  },
}));
