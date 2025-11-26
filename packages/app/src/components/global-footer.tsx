import { useState } from "react";
import { View, Pressable, Text, Platform } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AudioLines, Users, Plus, Download } from "lucide-react-native";
import { useRealtime } from "@/contexts/realtime-context";
import { useSession } from "@/contexts/session-context";
import { useFooterControls, FOOTER_HEIGHT } from "@/contexts/footer-controls-context";
import { RealtimeControls } from "./realtime-controls";
import { CreateAgentModal, ImportAgentModal } from "./create-agent-modal";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";

export function GlobalFooter() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();
  const { isRealtimeMode, startRealtime } = useRealtime();
  const { ws } = useSession();
  const { controls } = useFooterControls();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  // Guard Reanimated entry/exit transitions on Android to avoid ViewGroup.dispatchDraw crashes
  // tracked in react-native-reanimated#8422.
  const shouldDisableEntryExitAnimations = Platform.OS === "android";
  const realtimeFadeIn = shouldDisableEntryExitAnimations ? undefined : FadeIn.duration(250);
  const realtimeFadeOut = shouldDisableEntryExitAnimations ? undefined : FadeOut.duration(250);

  // Determine current screen type
  const isAgentScreen = pathname?.startsWith("/agent/");

  const hasRegisteredControls = !!controls;
  const showAgentControls = isAgentScreen && hasRegisteredControls;

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

  if (showAgentControls) {
    return (
      <Animated.View
        style={[
          styles.container,
          {
            paddingBottom: insets.bottom,
          },
          keyboardAnimatedStyle,
        ]}
      >
        {controls}
      </Animated.View>
    );
  }

  if (isAgentScreen) {
    return null;
  }

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
              onPress={() => setShowImportModal(true)}
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
                console.log("[GlobalFooter] New Agent button pressed");
                setShowCreateModal(true);
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
              onPress={startRealtime}
              disabled={!ws.isConnected}
              style={({ pressed }) => [
                styles.footerButton,
                !ws.isConnected && styles.buttonDisabled,
                pressed && !ws.isConnected && styles.buttonPressed,
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

      <CreateAgentModal
        isVisible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
      <ImportAgentModal
        isVisible={showImportModal}
        onClose={() => setShowImportModal(false)}
      />
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
}));
