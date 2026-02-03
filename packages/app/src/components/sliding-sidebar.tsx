import { useCallback, useMemo, useState, useEffect } from "react";
import { View, Pressable, Text, Platform, Modal, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { Plus, Settings, Users, AudioLines } from "lucide-react-native";
import { router } from "expo-router";
import { usePanelStore } from "@/stores/panel-store";
import { GroupedAgentList } from "./grouped-agent-list";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useSidebarAnimation } from "@/contexts/sidebar-animation-context";
import { useTauriDragHandlers, useTrafficLightPadding } from "@/utils/tauri-window";
import { useVoice } from "@/contexts/voice-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { VoicePanel } from "./voice-panel";

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
  const { connectionStates } = useDaemonConnections();
  const { isVoiceMode, startVoice, stopVoice } = useVoice();
  const [showVoiceHostPicker, setShowVoiceHostPicker] = useState(false);

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

  const voiceEligibleHosts = useMemo(() => {
    return Array.from(connectionStates.values()).filter((entry) => entry.status === "online");
  }, [connectionStates]);
  const hasAnyConfiguredHosts = connectionStates.size > 0;

  const handleToggleVoice = useCallback(() => {
    if (isVoiceMode) {
      void stopVoice().catch((error) => {
        console.error("[SlidingSidebar] Failed to stop voice", error);
        Alert.alert("Voice failed", "Unable to stop voice mode.");
      });
      return;
    }

    if (voiceEligibleHosts.length === 0) {
      if (!hasAnyConfiguredHosts) {
        Alert.alert(
          "No hosts available",
          "Add a host in Settings before starting Voice mode.",
          [{ text: "Open Settings", onPress: () => router.push("/settings") }, { text: "OK" }]
        );
        return;
      }
      Alert.alert(
        "Hosts reconnecting",
        "Every host is offline right now. Paseo reconnects automatically—try Voice mode again once one comes online."
      );
      return;
    }

    if (voiceEligibleHosts.length === 1) {
      void startVoice(voiceEligibleHosts[0].daemon.id).catch((error) => {
        console.error("[SlidingSidebar] Failed to start voice", error);
        Alert.alert("Voice failed", "Unable to start Voice mode for this host.");
      });
      return;
    }

    setShowVoiceHostPicker(true);
  }, [hasAnyConfiguredHosts, isVoiceMode, startVoice, stopVoice, voiceEligibleHosts]);

  const handleSelectVoiceHost = useCallback(
    (daemonId: string) => {
      setShowVoiceHostPicker(false);
      void startVoice(daemonId).catch((error) => {
        console.error("[SlidingSidebar] Failed to start voice", error);
        Alert.alert("Voice failed", "Unable to start Voice mode for this host.");
      });
    },
    [startVoice]
  );

  const handleDismissVoiceHostPicker = useCallback(() => {
    setShowVoiceHostPicker(false);
  }, []);

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

              {/* Middle: scrollable agent list */}
              <GroupedAgentList
                agents={limitedAgents}
                isRefreshing={isManualRefresh && isRevalidating}
                onRefresh={handleRefresh}
                selectedAgentId={selectedAgentId}
                onAgentSelect={handleAgentSelectMobile}
                parentGestureRef={closeGestureRef}
              />

              {isVoiceMode ? <VoicePanel /> : null}

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
                <View style={styles.footerIconRow}>
                  <Pressable
                    style={styles.footerIconButton}
                    testID="sidebar-voice"
                    onPress={handleToggleVoice}
                  >
                    {({ hovered }) => (
                      <AudioLines
                        size={20}
                        color={
                          isVoiceMode
                            ? theme.colors.foreground
                            : hovered
                              ? theme.colors.foreground
                              : theme.colors.foregroundMuted
                        }
                      />
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
            </View>
          </Animated.View>
        </GestureDetector>

        <Modal
          visible={showVoiceHostPicker}
          transparent
          animationType="fade"
          onRequestClose={handleDismissVoiceHostPicker}
        >
          <View style={styles.hostPickerOverlay}>
            <Pressable style={styles.hostPickerBackdrop} onPress={handleDismissVoiceHostPicker} />
            <View style={styles.hostPickerContainer}>
              <Text style={styles.hostPickerTitle}>Choose a host</Text>
              {voiceEligibleHosts.map((entry) => (
                <Pressable
                  key={entry.daemon.id}
                  style={styles.hostPickerButton}
                  onPress={() => handleSelectVoiceHost(entry.daemon.id)}
                >
                  <Text style={styles.hostPickerButtonText}>{entry.daemon.label}</Text>
                </Pressable>
              ))}
              <Pressable style={styles.hostPickerCancel} onPress={handleDismissVoiceHostPicker}>
                <Text style={styles.hostPickerCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
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

      {/* Middle: scrollable agent list */}
      <GroupedAgentList
        agents={limitedAgents}
        isRefreshing={isManualRefresh && isRevalidating}
        onRefresh={handleRefresh}
        selectedAgentId={selectedAgentId}
      />

      {isVoiceMode ? <VoicePanel /> : null}

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
        <View style={styles.footerIconRow}>
          <Pressable
            style={styles.footerIconButton}
            testID="sidebar-voice"
            onPress={handleToggleVoice}
          >
            {({ hovered }) => (
              <AudioLines
                size={20}
                color={
                  isVoiceMode
                    ? theme.colors.foreground
                    : hovered
                      ? theme.colors.foreground
                      : theme.colors.foregroundMuted
                }
              />
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
    paddingBottom: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  newAgentButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
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
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
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
  hostPickerOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    padding: theme.spacing[4],
  },
  hostPickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  hostPickerContainer: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius["2xl"],
    padding: theme.spacing[4],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  hostPickerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    marginBottom: theme.spacing[2],
  },
  hostPickerButton: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  hostPickerButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  hostPickerCancel: {
    marginTop: theme.spacing[2],
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
