import { useCallback, useEffect } from "react";
import { View, Pressable, useWindowDimensions, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  interpolate,
  Extrapolation,
  runOnJS,
  Easing,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { Plus, Settings } from "lucide-react-native";
import { router } from "expo-router";
import { useSidebarStore } from "@/stores/sidebar-store";
import { AgentList } from "./agent-list";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";

const DESKTOP_SIDEBAR_WIDTH = 320;
const ANIMATION_DURATION = 220;
const ANIMATION_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);

interface SlidingSidebarProps {
  selectedAgentId?: string;
}

export function SlidingSidebar({ selectedAgentId }: SlidingSidebarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const { isOpen, open, close } = useSidebarStore();
  const { agents, isRevalidating, refreshAll } = useAggregatedAgents();

  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  // Mobile sidebar is full width
  const sidebarWidth = isMobile ? windowWidth : DESKTOP_SIDEBAR_WIDTH;

  const translateX = useSharedValue(isOpen ? 0 : -sidebarWidth);
  const backdropOpacity = useSharedValue(isOpen ? 1 : 0);

  // Track if we're currently in a gesture (to prevent useEffect from interfering)
  const isGesturing = useSharedValue(false);

  useEffect(() => {
    // Don't animate if we're in the middle of a gesture
    if (isGesturing.value) {
      return;
    }

    const width = isMobile ? windowWidth : DESKTOP_SIDEBAR_WIDTH;
    translateX.value = withTiming(isOpen ? 0 : -width, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
    backdropOpacity.value = withTiming(isOpen ? 1 : 0, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
  }, [isOpen, translateX, backdropOpacity, isMobile, windowWidth, isGesturing]);

  const handleClose = useCallback(() => {
    close();
  }, [close]);

  const handleOpen = useCallback(() => {
    open();
  }, [open]);

  // Mobile: close sidebar and navigate
  const handleCreateAgentMobile = useCallback(() => {
    close();
    router.push("/");
  }, [close]);

  // Desktop: just navigate, don't close
  const handleCreateAgentDesktop = useCallback(() => {
    router.push("/");
  }, []);

  // Mobile: close sidebar and navigate
  const handleSettingsMobile = useCallback(() => {
    close();
    router.push("/settings");
  }, [close]);

  // Desktop: just navigate, don't close
  const handleSettingsDesktop = useCallback(() => {
    router.push("/settings");
  }, []);

  // Mobile: close sidebar when agent is selected
  // Use a quick fade instead of slide since navigation interrupts the animation
  const handleAgentSelectMobile = useCallback(() => {
    // Fast fade out - slide animations freeze during navigation
    backdropOpacity.value = withTiming(0, {
      duration: 100,
      easing: ANIMATION_EASING,
    });
    translateX.value = -windowWidth; // Snap immediately
    close();
  }, [close, translateX, backdropOpacity, windowWidth]);

  // Close gesture (swipe left to close when sidebar is open)
  const closeGesture = Gesture.Pan()
    // Only activate after 15px horizontal movement
    .activeOffsetX([-15, 15])
    // Fail if 10px vertical movement happens first (allow vertical scroll)
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
        translateX.value = withTiming(-windowWidth, {
          duration: ANIMATION_DURATION,
          easing: ANIMATION_EASING,
        });
        backdropOpacity.value = withTiming(0, {
          duration: ANIMATION_DURATION,
          easing: ANIMATION_EASING,
        });
        runOnJS(handleClose)();
      } else {
        translateX.value = withTiming(0, {
          duration: ANIMATION_DURATION,
          easing: ANIMATION_EASING,
        });
        backdropOpacity.value = withTiming(1, {
          duration: ANIMATION_DURATION,
          easing: ANIMATION_EASING,
        });
      }
    })
    .onFinalize(() => {
      isGesturing.value = false;
    });

  // Open gesture (swipe right from left edge to open when sidebar is closed)
  const openGesture = Gesture.Pan()
    .hitSlop({ right: windowWidth * 0.5 })
    // Only activate after 15px horizontal movement to the right
    .activeOffsetX(15)
    // Fail if 10px vertical movement happens first (allow vertical scroll)
    .failOffsetY([-10, 10])
    .onStart(() => {
      isGesturing.value = true;
    })
    .onUpdate((event) => {
      if (!isMobile) return;
      // Start from closed position (-windowWidth) and move towards 0
      const newTranslateX = Math.min(0, -windowWidth + event.translationX);
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
      // Open if dragged more than 1/3 of sidebar or fast swipe
      const shouldOpen = event.translationX > windowWidth / 3 || event.velocityX > 500;
      if (shouldOpen) {
        translateX.value = withTiming(0, {
          duration: ANIMATION_DURATION,
          easing: ANIMATION_EASING,
        });
        backdropOpacity.value = withTiming(1, {
          duration: ANIMATION_DURATION,
          easing: ANIMATION_EASING,
        });
        runOnJS(handleOpen)();
      } else {
        translateX.value = withTiming(-windowWidth, {
          duration: ANIMATION_DURATION,
          easing: ANIMATION_EASING,
        });
        backdropOpacity.value = withTiming(0, {
          duration: ANIMATION_DURATION,
          easing: ANIMATION_EASING,
        });
      }
    })
    .onFinalize(() => {
      isGesturing.value = false;
    });

  const swipeGesture = Gesture.Simultaneous(
    isOpen ? closeGesture : openGesture,
    Gesture.Native()
  );

  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
    pointerEvents: backdropOpacity.value > 0.01 ? "auto" : "none",
  }));

  // Render mobile sidebar with edge swipe
  if (isMobile) {
    return (
      <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
        {/* Backdrop */}
        <Animated.View style={[styles.backdrop, backdropAnimatedStyle]}>
          <Pressable style={styles.backdropPressable} onPress={handleClose} />
        </Animated.View>

        {/* Sidebar */}
        <GestureDetector gesture={swipeGesture}>
          <Animated.View
            style={[
              styles.mobileSidebar,
              { width: windowWidth, paddingTop: insets.top, paddingBottom: insets.bottom },
              sidebarAnimatedStyle,
            ]}
          >
            {/* Header: New Agent button */}
            <View style={styles.sidebarHeader}>
              <Pressable
                style={styles.newAgentButton}
                onPress={handleCreateAgentMobile}
              >
                <Plus size={18} color={theme.colors.foreground} />
                <Text style={styles.newAgentButtonText}>New Agent</Text>
              </Pressable>
            </View>

            {/* Middle: scrollable agent list */}
            <AgentList
              agents={agents}
              isRefreshing={isRevalidating}
              onRefresh={refreshAll}
              selectedAgentId={selectedAgentId}
              onAgentSelect={handleAgentSelectMobile}
            />

            {/* Footer: Settings button */}
            <View style={styles.sidebarFooter}>
              <Pressable
                style={styles.settingsButton}
                onPress={handleSettingsMobile}
              >
                <Settings size={20} color={theme.colors.mutedForeground} />
                <Text style={styles.settingsButtonText}>Settings</Text>
              </Pressable>
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
      {/* Header: New Agent button */}
      <View style={styles.sidebarHeader}>
        <Pressable
          style={styles.newAgentButton}
          onPress={handleCreateAgentDesktop}
        >
          <Plus size={18} color={theme.colors.mutedForeground} />
          <Text style={styles.newAgentButtonText}>New Agent</Text>
        </Pressable>
      </View>

      {/* Middle: scrollable agent list */}
      <AgentList
        agents={agents}
        isRefreshing={isRevalidating}
        onRefresh={refreshAll}
        selectedAgentId={selectedAgentId}
      />

      {/* Footer: Settings button */}
      <View style={styles.sidebarFooter}>
        <Pressable
          style={styles.settingsButton}
          onPress={handleSettingsDesktop}
        >
          <Settings size={20} color={theme.colors.mutedForeground} />
          <Text style={styles.settingsButtonText}>Settings</Text>
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
    backgroundColor: theme.colors.background,
  },
  desktopSidebar: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  sidebarHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[2],
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
  },
  newAgentButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  sidebarFooter: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  settingsButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  settingsButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.mutedForeground,
  },
}));
