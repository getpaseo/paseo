import { useCallback, useMemo, useState } from "react";
import { View, Pressable, Text, Platform, Modal, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AudioLines, Users, Plus, Download } from "lucide-react-native";
import { useRealtime } from "@/contexts/realtime-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { FOOTER_HEIGHT } from "@/constants/layout";
import { RealtimeControls } from "./realtime-controls";
import { ImportAgentModal } from "./create-agent-modal";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";

export function HomeFooter() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { isRealtimeMode, startRealtime } = useRealtime();
  const { connectionStates } = useDaemonConnections();
  const [showImportModal, setShowImportModal] = useState(false);
  const [showRealtimeHostPicker, setShowRealtimeHostPicker] = useState(false);
  // Guard Reanimated entry/exit transitions on Android to avoid ViewGroup.dispatchDraw crashes
  // tracked in react-native-reanimated#8422.
  const shouldDisableEntryExitAnimations = Platform.OS === "android";
  const realtimeFadeIn = shouldDisableEntryExitAnimations ? undefined : FadeIn.duration(250);
  const realtimeFadeOut = shouldDisableEntryExitAnimations ? undefined : FadeOut.duration(250);

  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const bottomInset = insets.bottom;

  const keyboardAnimatedStyle = useAnimatedStyle(
    () => {
      "worklet";
      const absoluteHeight = Math.abs(keyboardHeight.value);
      const shift = Math.max(0, absoluteHeight - bottomInset);
      return {
        transform: [{ translateY: -shift }],
      };
    },
    [bottomInset],
  );

  const realtimeEligibleHosts = useMemo(() => {
    return Array.from(connectionStates.values()).filter((entry) => entry.status === "online");
  }, [connectionStates]);
  const hasAnyConfiguredHosts = connectionStates.size > 0;

  const handleStartRealtime = useCallback(() => {
    if (realtimeEligibleHosts.length === 0) {
      if (!hasAnyConfiguredHosts) {
        Alert.alert(
          "No hosts available",
          "Add a host in Settings before starting realtime mode."
        );
        return;
      }
      Alert.alert(
        "Hosts reconnecting",
        "Every host is offline right now. Paseo reconnects automatically—try realtime again once one comes online."
      );
      return;
    }
    if (realtimeEligibleHosts.length === 1) {
      void startRealtime(realtimeEligibleHosts[0].daemon.id).catch((error) => {
        console.error("[HomeFooter] Failed to start realtime", error);
        Alert.alert("Realtime failed", "Unable to start realtime mode for this host.");
      });
      return;
    }
    setShowRealtimeHostPicker(true);
  }, [hasAnyConfiguredHosts, realtimeEligibleHosts, startRealtime]);

  const handleSelectRealtimeHost = useCallback(
    (daemonId: string) => {
      setShowRealtimeHostPicker(false);
      void startRealtime(daemonId).catch((error) => {
        console.error("[HomeFooter] Failed to start realtime", error);
        Alert.alert("Realtime failed", "Unable to start realtime mode for this host.");
      });
    },
    [startRealtime]
  );

  const handleDismissHostPicker = useCallback(() => {
    setShowRealtimeHostPicker(false);
  }, []);

  // For home and orchestrator screens, show action buttons with realtime stacked on top
  const nonAgentFooterHeight = isRealtimeMode
    ? FOOTER_HEIGHT * 2 + insets.bottom
    : FOOTER_HEIGHT + insets.bottom;

  const iconSize = 24;
  const iconStyle = { width: iconSize, height: iconSize };

  return (
    <>
      <Animated.View
        style={[
          styles.container,
          {
            paddingBottom: insets.bottom,
            height: nonAgentFooterHeight,
          },
          keyboardAnimatedStyle,
        ]}
      >
        <View style={styles.nonAgentContent}>
          {/* Realtime controls - only visible when active */}
          {isRealtimeMode && (
            <Animated.View
              style={styles.realtimeSection}
              entering={realtimeFadeIn}
              exiting={realtimeFadeOut}
            >
              <RealtimeControls />
            </Animated.View>
          )}

          {/* Action menu */}
          <View style={styles.actionButtonContainer}>
            <Pressable
              onPress={() => router.push("/")}
              style={({ pressed }) => [
                styles.footerButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <View style={styles.footerIconWrapper}>
                <Users
                  size={iconSize}
                  color={theme.colors.foreground}
                  style={iconStyle}
                />
              </View>
              <Text style={styles.footerButtonText}>Agents</Text>
            </Pressable>

            <Pressable
              onPress={() => {
                setShowImportModal(true);
              }}
              style={({ pressed }) => [
                styles.footerButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <View style={styles.footerIconWrapper}>
                <Download
                  size={iconSize}
                  color={theme.colors.foreground}
                  style={iconStyle}
                />
              </View>
              <Text style={styles.footerButtonText}>Import</Text>
            </Pressable>

            <Pressable
              onPress={() => {
                console.log("[HomeFooter] New Agent button pressed");
                router.push("/agent/new");
              }}
              style={({ pressed }) => [
                styles.footerButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <View style={styles.footerIconWrapper}>
                <Plus
                  size={iconSize}
                  color={theme.colors.foreground}
                  style={iconStyle}
                />
              </View>
              <Text style={styles.footerButtonText}>New Agent</Text>
            </Pressable>

            <Pressable
              onPress={handleStartRealtime}
              disabled={realtimeEligibleHosts.length === 0}
              style={({ pressed }) => [
                styles.footerButton,
                realtimeEligibleHosts.length === 0 && styles.buttonDisabled,
                pressed && realtimeEligibleHosts.length === 0 && styles.buttonPressed,
              ]}
            >
              <View style={styles.footerIconWrapper}>
                <AudioLines
                  size={iconSize}
                  color={theme.colors.foreground}
                  style={iconStyle}
                />
              </View>
              <Text style={styles.footerButtonText}>Realtime</Text>
            </Pressable>
          </View>
        </View>
      </Animated.View>

      <ImportAgentModal
        isVisible={showImportModal}
        onClose={() => setShowImportModal(false)}
      />
      <Modal
        visible={showRealtimeHostPicker}
        transparent
        animationType="fade"
        onRequestClose={handleDismissHostPicker}
      >
        <View style={styles.hostPickerOverlay}>
          <Pressable style={styles.hostPickerBackdrop} onPress={handleDismissHostPicker} />
          <View style={styles.hostPickerContainer}>
            <Text style={styles.hostPickerTitle}>Choose a host</Text>
            {realtimeEligibleHosts.map((entry) => (
              <Pressable
                key={entry.daemon.id}
                style={styles.hostPickerButton}
                onPress={() => handleSelectRealtimeHost(entry.daemon.id)}
              >
                <Text style={styles.hostPickerButtonText}>{entry.daemon.label}</Text>
              </Pressable>
            ))}
            <Pressable style={styles.hostPickerCancel} onPress={handleDismissHostPicker}>
              <Text style={styles.hostPickerCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.background,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  nonAgentContent: {
    flexDirection: "column",
  },
  realtimeSection: {
    height: FOOTER_HEIGHT,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  actionButtonContainer: {
    flexDirection: "row",
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    height: FOOTER_HEIGHT,
  },
  footerButton: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
  },
  footerIconWrapper: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  footerButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.5,
  },
  hostPickerOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  hostPickerBackdrop: {
    flex: 1,
  },
  hostPickerContainer: {
    backgroundColor: theme.colors.card,
    padding: theme.spacing[4],
    borderTopLeftRadius: theme.borderRadius.xl,
    borderTopRightRadius: theme.borderRadius.xl,
    gap: theme.spacing[3],
  },
  hostPickerTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  hostPickerButton: {
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.muted,
  },
  hostPickerButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  hostPickerCancel: {
    paddingVertical: theme.spacing[3],
  },
  hostPickerCancelText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
